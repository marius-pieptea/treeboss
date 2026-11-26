import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { db } from "../db";
import { ENGINES, resolveBinary } from "../engines/registry";
import { shimInvocation } from "../engines/win-shim";
import { home } from "../paths";
import { DETACH_GROUP, killTree } from "../proctree";
import { ARTIFACT_ID_RE, artifactIdFromUrl, parseArtifactUrl } from "./capture";
import { getArtifact, saveError, saveRead } from "./store";
import {
  MIN_CLAUDE_VERSION,
  type AccountState,
  type Artifact,
  type ArtifactError,
  type ArtifactOwner,
} from "./types";

export interface SpawnInput {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}

export interface SpawnOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type ClaudeSpawner = (input: SpawnInput) => Promise<SpawnOutput>;

export interface AccountInfo {
  state: AccountState;
  version: string | null;
}

export class AlreadyReadingError extends Error {
  readonly status = 409;
  constructor() {
    super("Already reading.");
  }
}

const READ_TIMEOUT_MS = 90_000;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_READS = 2;
const MAX_SUMMARY_CHARS = 2000;
const MAX_PROMPT_CHARS = 500;
const DEFAULT_READ_PROMPT = "Summarize this artifact in 3 sentences: what it is and what it contains.";
const LIST_LINE_RE = /^- \((mine|shared)\) (.+?) — (https:\/\/claude\.ai\/\S+) — updated (.+)$/;

const NOT_SIGNED_IN_RE = /\bnot (?:logged|signed) in\b|\/login\b|\bunauthenticated\b|\b401\b/i;
const NO_ACCESS_RE = /\b403\b|\b404\b|not authorized|forbidden|not found|no access/i;
const NO_PLAN_RE = /\b(plan|subscription)\b.*\b(not|doesn't|does not)\b|upgrade/i;

let customSpawner: ClaudeSpawner | null = null;
let versionCache: { value: string | null; checkedAt: number } | null = null;
let accountState: AccountState = "unknown";
let lastVersion: string | null = null;

const inFlightById = new Map<string, Promise<Artifact | null>>();
let activeReads = 0;
const waitQueue: Array<() => void> = [];

/** Inject a fake Claude CLI spawner for tests (pass null to restore the default). */
export function setClaudeSpawner(spawner: ClaudeSpawner | null): void {
  customSpawner = spawner;
  resetReaderState();
}

/** Clear cached Claude version and account state (for tests). */
export function resetReaderState(): void {
  versionCache = null;
  accountState = "unknown";
  lastVersion = null;
}

/** Wait for all currently queued or active artifact reads to settle. */
export async function drainReads(): Promise<void> {
  await Promise.allSettled([...inFlightById.values()]);
}

/** True when a read is currently queued or running for this artifact id. */
export function isReading(id: string): boolean {
  return inFlightById.has(id);
}

/** Await an in-flight read for `id`, or return the current DB row if none is running. */
export async function waitForRead(id: string): Promise<Artifact | null> {
  const p = inFlightById.get(id);
  if (p) return p;
  return getArtifact(id);
}

/** Return the most recently observed account state and Claude Code version. */
export function getAccount(): AccountInfo {
  return { state: accountState, version: lastVersion };
}

function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CI: "true",
    FORCE_COLOR: "0",
    CLAUDE_NON_INTERACTIVE: "1",
    CLAUDE_CODE_ARTIFACT: "1",
  };
  delete env.CLAUDECODE;
  return env;
}

async function defaultClaudeSpawner(input: SpawnInput): Promise<SpawnOutput> {
  return new Promise((resolve) => {
    const inv = shimInvocation(input.bin, input.args);
    let child;
    try {
      child = spawn(inv.file, inv.args, {
        cwd: input.cwd,
        env: input.env as NodeJS.ProcessEnv,
        detached: DETACH_GROUP,
        windowsHide: true,
        windowsVerbatimArguments: inv.verbatim,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      return resolve({ exitCode: 1, stdout: "", stderr: String(err?.message ?? err) });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killTree(child.pid, "SIGKILL"), 1500);
      killTimer.unref?.();
    }, input.timeoutMs);
    timer.unref?.();

    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ exitCode: 1, stdout, stderr: stderr || String(err?.message ?? err), timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

function runClaude(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<SpawnOutput> {
  const spawner = customSpawner ?? defaultClaudeSpawner;
  return spawner({ bin, args, cwd, env: claudeEnv(), timeoutMs });
}

/** Return true when dotted version `v` is strictly older than `min`. */
export function isVersionTooOld(v: string, min = MIN_CLAUDE_VERSION): boolean {
  const a = v.split(".").map((n) => Number(n) || 0);
  const b = min.split(".").map((n) => Number(n) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv;
  }
  return false;
}

/** Probe `claude --version`, cached for 10 minutes unless `force` is true. */
export async function claudeVersion(force = false): Promise<string | null> {
  if (!force && versionCache && Date.now() - versionCache.checkedAt < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  const bin = resolveBinary(ENGINES.claude);
  if (!bin && !customSpawner) {
    versionCache = { value: null, checkedAt: Date.now() };
    lastVersion = null;
    return null;
  }
  const out = await runClaude(bin ?? "claude", ["--version"], home(), VERSION_TIMEOUT_MS);
  const match = out.exitCode === 0 ? /\d+\.\d+(?:\.\d+)?/.exec(`${out.stdout}\n${out.stderr}`) : null;
  const version = match ? match[0] : null;
  versionCache = { value: version, checkedAt: Date.now() };
  lastVersion = version;
  return version;
}

/** Classify a raw error message from Claude Code / claude.ai into an ArtifactError. */
export function classify(text: string, opts?: { toolMissing?: boolean }): ArtifactError {
  if (NOT_SIGNED_IN_RE.test(text)) return "not_signed_in";
  if (opts?.toolMissing) return "too_old";
  if (NO_ACCESS_RE.test(text)) return "no_access";
  if (NO_PLAN_RE.test(text)) return "no_plan";
  return "read_failed";
}

function recordErrorAccountState(err: ArtifactError): void {
  if (err === "not_signed_in" || err === "no_plan" || err === "too_old") {
    accountState = err;
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : null))
      .filter((s: string | null): s is string => s !== null);
    if (parts.length > 0) return parts.join("\n");
  }
  return JSON.stringify(content ?? "");
}

interface ParsedStream {
  initTools: string[] | null;
  artifactToolIds: Set<string>;
  toolResult: { text: string; isError: boolean } | null;
  assistantTexts: string[];
  finalResult: { text: string; isError: boolean } | null;
}

function parseStreamOutput(stdout: string): ParsedStream {
  const artifactToolIds = new Set<string>();
  let initTools: string[] | null = null;
  let toolResult: { text: string; isError: boolean } | null = null;
  const assistantTexts: string[] = [];
  let finalResult: { text: string; isError: boolean } | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    switch (event?.type) {
      case "system": {
        if (event.subtype === "init" && Array.isArray(event.tools)) {
          initTools = event.tools.filter((t: unknown): t is string => typeof t === "string");
        }
        break;
      }
      case "tool_use": {
        const name = event.tool_name || event.name;
        const toolId = event.tool_id || event.id;
        if (toolId && name === "Artifact") artifactToolIds.add(toolId);
        break;
      }
      case "tool_result": {
        const toolId = event.tool_id || event.tool_use_id;
        if (toolId && artifactToolIds.has(toolId)) {
          toolResult = {
            text: extractToolResultText(event.output ?? event.content),
            isError: Boolean(event.is_error),
          };
        }
        break;
      }
      case "assistant": {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type === "tool_use") {
            if (block.id && block.name === "Artifact") artifactToolIds.add(block.id);
          } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            assistantTexts.push(block.text.trim());
          }
        }
        break;
      }
      case "user": {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type !== "tool_result") continue;
          if (block.tool_use_id && artifactToolIds.has(block.tool_use_id)) {
            toolResult = {
              text: extractToolResultText(block.content),
              isError: Boolean(block.is_error),
            };
          }
        }
        break;
      }
      case "result": {
        const text =
          typeof event.result === "string"
            ? event.result
            : extractToolResultText(event.result ?? event.error ?? "");
        finalResult = { text, isError: Boolean(event.is_error) };
        break;
      }
    }
  }

  return { initTools, artifactToolIds, toolResult, assistantTexts, finalResult };
}

async function acquireSlot(): Promise<void> {
  if (activeReads < MAX_CONCURRENT_READS) {
    activeReads++;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
}

function releaseSlot(): void {
  const next = waitQueue.shift();
  if (next) {
    next();
  } else {
    activeReads--;
  }
}

async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

function sanitizePrompt(raw?: string): string {
  const clean = (raw ?? "").replace(/[\x00-\x1f]/g, "").trim().slice(0, MAX_PROMPT_CHARS);
  return clean || DEFAULT_READ_PROMPT;
}

function claudeArtifactArgs(prompt: string): string[] {
  return [
    "-p",
    "--tools",
    "Artifact",
    "--allowedTools",
    "Artifact",
    "--strict-mcp-config",
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "stream-json",
    "--verbose",
    prompt,
  ];
}

async function executeRead(id: string, url: string, opts?: { prompt?: string }): Promise<Artifact | null> {
  if (!ARTIFACT_ID_RE.test(id)) {
    return saveError(id, "read_failed", "Invalid artifact id.");
  }
  const parsedUrl = parseArtifactUrl(url);
  if (!parsedUrl || parsedUrl.id !== id) {
    return saveError(id, "read_failed", "Invalid artifact URL.");
  }

  const version = await claudeVersion();
  if (version !== null && isVersionTooOld(version, MIN_CLAUDE_VERSION)) {
    accountState = "too_old";
    return saveError(id, "too_old", `Claude Code ${version} is older than ${MIN_CLAUDE_VERSION}.`);
  }

  const bin = resolveBinary(ENGINES.claude);
  if (!bin && !customSpawner) {
    return saveError(id, "read_failed", "Claude Code is not installed.");
  }

  const outDir = path.join(home(), "artifacts", id);
  fs.mkdirSync(outDir, { recursive: true });

  const summaryPrompt = sanitizePrompt(opts?.prompt);
  const prompt = `Use the Artifact tool once with action "read", url ${JSON.stringify(parsedUrl.url)}, path "index.html", out_dir ${JSON.stringify(outDir)}, prompt ${JSON.stringify(summaryPrompt)} Then reply with the single word done.`;

  const out = await runClaude(bin ?? "claude", claudeArtifactArgs(prompt), outDir, READ_TIMEOUT_MS);

  if (out.timedOut) {
    return saveError(id, "read_failed", out.stderr.trim() || "Timed out reading artifact after 90s.");
  }

  const parsed = parseStreamOutput(out.stdout);
  if (parsed.toolResult) {
    if (parsed.toolResult.isError) {
      const err = classify(parsed.toolResult.text);
      recordErrorAccountState(err);
      return saveError(id, err, parsed.toolResult.text);
    }
    const htmlPath = path.join(outDir, "index.html");
    if (parsed.toolResult.text.includes("File saved:") && fs.existsSync(htmlPath)) {
      accountState = "ok";
      return saveRead(id, { htmlPath, owner: "mine" });
    }
    accountState = "ok";
    return saveRead(id, { summary: parsed.toolResult.text.slice(0, MAX_SUMMARY_CHARS), owner: "shared" });
  }

  const raw = [parsed.finalResult?.text, ...parsed.assistantTexts, out.stderr.trim()]
    .filter(Boolean)
    .join("\n")
    .trim();
  const toolMissing = parsed.initTools !== null && !parsed.initTools.includes("Artifact");
  const err = classify(raw, { toolMissing });
  recordErrorAccountState(err);
  return saveError(id, err, raw || "Failed to read artifact.");
}

/**
 * Read one artifact through headless Claude Code (`Artifact` tool `action: "read"`).
 * Only one read runs per artifact id at a time, and at most 2 reads run concurrently overall.
 */
export async function readArtifact(id: string, opts?: { prompt?: string }): Promise<Artifact | null> {
  if (!ARTIFACT_ID_RE.test(id)) return null;
  if (inFlightById.has(id)) throw new AlreadyReadingError();
  const existing = getArtifact(id);
  if (!existing) return null;

  const p = withReadSlot(() => executeRead(id, existing.url, opts)).finally(() => {
    inFlightById.delete(id);
  });
  inFlightById.set(id, p);
  return p;
}

/**
 * Refresh metadata of known artifacts from the signed-in claude.ai account (`Artifact` tool `action: "list"`).
 */
export async function listAccount(opts?: { force?: boolean }): Promise<{ account: AccountInfo; updated: number }> {
  const version = await claudeVersion(Boolean(opts?.force));
  if (version !== null && isVersionTooOld(version, MIN_CLAUDE_VERSION)) {
    accountState = "too_old";
    return { account: getAccount(), updated: 0 };
  }

  const bin = resolveBinary(ENGINES.claude);
  if (!bin && !customSpawner) {
    return { account: getAccount(), updated: 0 };
  }

  const prompt = 'Use the Artifact tool once with action "list". Reply with its output verbatim.';
  const out = await runClaude(bin ?? "claude", claudeArtifactArgs(prompt), home(), READ_TIMEOUT_MS);

  if (out.timedOut) {
    return { account: getAccount(), updated: 0 };
  }

  const parsed = parseStreamOutput(out.stdout);
  if (parsed.toolResult) {
    if (parsed.toolResult.isError) {
      recordErrorAccountState(classify(parsed.toolResult.text));
      return { account: getAccount(), updated: 0 };
    }

    let updated = 0;
    const stmt = db().prepare(
      "UPDATE artifacts SET title = ?, owner = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL",
    );
    for (const line of parsed.toolResult.text.split(/\r?\n/)) {
      const m = LIST_LINE_RE.exec(line.trim());
      if (!m) continue;
      const owner = m[1] as ArtifactOwner;
      const title = m[2].trim();
      const url = m[3].trim();
      const updatedStr = m[4].trim();
      const id = artifactIdFromUrl(url);
      if (!id) continue;
      const existing = getArtifact(id);
      if (!existing) continue;
      const parsedDate = Date.parse(updatedStr);
      const updatedAt = Number.isFinite(parsedDate) ? parsedDate : existing.updatedAt;
      stmt.run(title || existing.title, owner, updatedAt, id);
      updated++;
    }
    accountState = "ok";
    return { account: getAccount(), updated };
  }

  const raw = [parsed.finalResult?.text, ...parsed.assistantTexts, out.stderr.trim()]
    .filter(Boolean)
    .join("\n")
    .trim();
  const toolMissing = parsed.initTools !== null && !parsed.initTools.includes("Artifact");
  recordErrorAccountState(classify(raw, { toolMissing }));
  return { account: getAccount(), updated: 0 };
}
