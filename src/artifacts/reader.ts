import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { db } from "../db";
import { ENGINES, resolveBinary } from "../engines/registry";
import { shimInvocation } from "../engines/win-shim";
import { home } from "../paths";
import { DETACH_GROUP, killTree } from "../proctree";
import { ARTIFACT_ID_RE, artifactIdFromUrl, intentFromType, parseArtifactUrl } from "./capture";
import { getArtifact, listArtifactFiles, saveError, saveRead } from "./store";
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
const BATCH_READ_TIMEOUT_MS = 300_000;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_READS = 2;
const MAX_SUMMARY_CHARS = 2000;
const MAX_PROMPT_CHARS = 500;
const MAX_PROJECT_FILES = 300;
const MAX_PROJECT_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_ASSETS = 200;
const MAX_ASSET_BYTES = 15 * 1024 * 1024;
const MAX_ASSETS_TOTAL_BYTES = 80 * 1024 * 1024;
const READ_BATCH_SIZE = 25;
const ASSET_READ_RUN_SIZE = 40;
const MAX_BINARY_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_PROMPT = "Summarize this artifact in 3 sentences: what it is and what it contains.";
const LIST_LINE_RE = /^- \((mine|shared)\) (.+?) — (https:\/\/claude\.ai\/\S+) — updated (.+)$/;
const ASSET_ID_RE = /^[0-9a-f]{32}$/;
const DC_RUNTIME_PATH = "artifact-type/dc-runtime.js";
const DC_RUNTIME_LINE_RE = /(?:^|[\s`"'(])artifact-type\/dc-runtime\.js(?=["'`\s),]|$)/;

const USAGE_LIMIT_RE =
  /\bhit your\b.{0,40}\blimit\b|\busage limit\b|\brate limit\b|\blimit reached\b|\bout of (extra )?usage\b|\b429\b/i;
const NOT_SIGNED_IN_RE = /\bnot (?:logged|signed) in\b|\/login\b|\bunauthenticated\b|\b401\b/i;
const NO_ACCESS_RE = /\b403\b|\b404\b|not authorized|forbidden|not found|no access/i;
const NO_PLAN_RE = /\b(plan|subscription)\b.*\b(not|doesn't|does not)\b|upgrade/i;

const DOCS_READ_TOOL = "mcp__claude_ai_Claude_Docs__read";
const DOCS_EXPORT_TOOL = "mcp__claude_ai_Claude_Docs__export";
const ALLOWED_DOCS_TOOLS = new Set(["ToolSearch", DOCS_READ_TOOL, DOCS_EXPORT_TOOL]);
const DOCS_DISALLOWED_TOOL_ERROR =
  "The Claude Docs read used a tool it was not allowed to use, so its result was discarded.";
const DOCS_NOT_CONNECTED_ERROR =
  "Claude Docs isn't connected in Claude Code. Open claude.ai → Settings → Connectors, or run /mcp in Claude Code.";
const CONTENT_TRUNCATED_NOTE = "\n\n[truncated at 2 MB]";
const FILES_TRUNCATED_MARKER = ".files-truncated";
const SAFE_PROJECT_PATH_RE =
  /^project\/[A-Za-z0-9._@+() -]{1,200}(\/[A-Za-z0-9._@+() -]{1,200})*$/;

const TEXT_EXTS = new Set([
  ".html",
  ".htm",
  ".json",
  ".md",
  ".markdown",
  ".txt",
  ".css",
  ".scss",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".svg",
  ".xml",
  ".yaml",
  ".yml",
  ".csv",
  ".toml",
]);

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
  if (USAGE_LIMIT_RE.test(text)) return "usage_limit";
  if (NOT_SIGNED_IN_RE.test(text)) return "not_signed_in";
  if (opts?.toolMissing) return "too_old";
  if (NO_ACCESS_RE.test(text)) return "no_access";
  if (NO_PLAN_RE.test(text)) return "no_plan";
  return "read_failed";
}

function recordErrorAccountState(err: ArtifactError): void {
  if (err === "not_signed_in" || err === "no_plan" || err === "too_old" || err === "usage_limit") {
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

interface ToolCallResult {
  toolId: string;
  name: string;
  input: any;
  text: string;
  isError: boolean;
  structured?: any;
}

interface ToolUseCall {
  toolId: string | null;
  name: string;
  input: any;
}

interface ParsedStream {
  initTools: string[] | null;
  toolUses: ToolUseCall[];
  toolResults: ToolCallResult[];
  artifactToolResults: ToolCallResult[];
  artifactToolResult: ToolCallResult | null;
  assistantTexts: string[];
  finalResult: { text: string; isError: boolean } | null;
}

function parseStreamOutput(stdout: string): ParsedStream {
  const toolCalls = new Map<string, { name: string; input: any }>();
  const toolUses: ToolUseCall[] = [];
  const toolResults: ToolCallResult[] = [];
  const artifactToolResults: ToolCallResult[] = [];
  let initTools: string[] | null = null;
  let artifactToolResult: ToolCallResult | null = null;
  const assistantTexts: string[] = [];
  let finalResult: { text: string; isError: boolean } | null = null;

  const pushResult = (toolId: string, content: unknown, isError: boolean, structured?: any) => {
    const call = toolCalls.get(toolId);
    if (!call) return;
    const res: ToolCallResult = {
      toolId,
      name: call.name,
      input: call.input,
      text: extractToolResultText(content),
      isError,
      structured,
    };
    toolResults.push(res);
    if (call.name === "Artifact") {
      artifactToolResult = res;
      artifactToolResults.push(res);
    }
  };

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
        const toolId = event.tool_id || event.id || null;
        if (typeof name === "string") {
          toolUses.push({ toolId, name, input: event.input });
          if (toolId) {
            toolCalls.set(toolId, { name, input: event.input });
          }
        }
        break;
      }
      case "tool_result": {
        const toolId = event.tool_id || event.tool_use_id;
        if (toolId) {
          pushResult(toolId, event.output ?? event.content, Boolean(event.is_error), event.tool_use_result);
        }
        break;
      }
      case "assistant": {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block?.type === "tool_use") {
            if (typeof block.name === "string") {
              const toolId = typeof block.id === "string" ? block.id : null;
              toolUses.push({ toolId, name: block.name, input: block.input });
              if (toolId) {
                toolCalls.set(toolId, { name: block.name, input: block.input });
              }
            }
          } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            assistantTexts.push(block.text.trim());
          }
        }
        break;
      }
      case "user": {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;
        const resultBlocks = content.filter((b: any) => b?.type === "tool_result" && b.tool_use_id);
        for (const block of resultBlocks) {
          pushResult(
            block.tool_use_id,
            block.content,
            Boolean(block.is_error),
            resultBlocks.length === 1 ? event.tool_use_result : undefined,
          );
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

  return { initTools, toolUses, toolResults, artifactToolResults, artifactToolResult, assistantTexts, finalResult };
}

export interface ParsedArtifactHeader {
  artifactUuid: string | null;
  owned: boolean;
  typeName: string | null;
  typeId: string | null;
  docsId: string | null;
  title: string | null;
  isTyped: boolean;
}

/** Parse the metadata header returned by `Artifact` `read` without `path`. */
export function parseArtifactHeader(text: string): ParsedArtifactHeader {
  const headerLine = /\bArtifact\s+([A-Za-z0-9-]+)\s*\(version\b[^\r\n]*/i.exec(text);
  const artifactUuid = headerLine && ARTIFACT_ID_RE.test(headerLine[1]!) ? headerLine[1]! : null;

  let owned = false;
  if (headerLine) {
    const line = headerLine[0];
    if (/\bowned by you\b/i.test(line) || /\bwriter\b/i.test(line)) {
      owned = true;
    } else if (/\bowned by\b/i.test(line)) {
      owned = false;
    }
  } else if (/^[^\r\n]*\bowned by you\b/mi.test(text)) {
    owned = true;
  }

  const typeMatch = /\ban?\s+Artifact of type "([^"\r\n]+)"/i.exec(text);
  const typeName = typeMatch ? typeMatch[1]!.trim() || null : null;

  const typeIdMatch =
    /Created from the Artifact type https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]+)/i.exec(text);
  const typeId = typeIdMatch && ARTIFACT_ID_RE.test(typeIdMatch[1]!) ? typeIdMatch[1]! : null;

  const docsIdMatch =
    /Claude Docs id is(?: this Artifact's own id,?)?\s*"([A-Za-z0-9-]+)"/i.exec(text);
  let docsId = docsIdMatch && ARTIFACT_ID_RE.test(docsIdMatch[1]!) ? docsIdMatch[1]! : null;
  if (!docsId && typeName?.toLowerCase() === "docs" && artifactUuid) {
    docsId = artifactUuid;
  }

  const textWithoutTypeInstructions = text.replace(/<artifact-type-instructions>[\s\S]*?<\/artifact-type-instructions>/gi, "");
  const titleMatch = /^Title:\s*(.+)$/mi.exec(textWithoutTypeInstructions);
  const title = titleMatch ? titleMatch[1]!.trim() || null : null;

  return {
    artifactUuid,
    owned,
    typeName,
    typeId,
    docsId,
    title,
    isTyped: Boolean(typeName || typeId || docsId),
  };
}

function parseByteSize(line: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(B|bytes?|KB|KiB|MB|MiB|GB|GiB)\b/i.exec(line);
  if (!m) return null;
  const val = Number(m[1]);
  if (!Number.isFinite(val)) return null;
  const unit = m[2]!.toLowerCase();
  if (unit === "b" || unit === "byte" || unit === "bytes") return val;
  if (unit === "kb" || unit === "kib") return val * 1024;
  if (unit === "mb" || unit === "mib") return val * 1024 * 1024;
  if (unit === "gb" || unit === "gib") return val * 1024 * 1024 * 1024;
  return null;
}

function isBinaryFilePath(relPath: string): boolean {
  const ext = path.posix.extname(relPath.toLowerCase());
  return !TEXT_EXTS.has(ext);
}

function isSafeProjectPath(candidate: string): boolean {
  if (!SAFE_PROJECT_PATH_RE.test(candidate)) return false;
  if (candidate.includes("..") || candidate.includes("\\") || /[\x00-\x1f]/.test(candidate)) return false;
  return candidate.split("/").every((seg) => seg !== "." && seg !== "..");
}

/** Parse `project/` file paths from `Artifact` `list` scope `"files"` output. */
export function parseFilesList(text: string): {
  typeName: string | null;
  paths: string[];
  truncated: boolean;
  hasDcRuntime: boolean;
} {
  const typeMatch = /\ban?\s+Artifact of type "([^"\r\n]+)"/i.exec(text);
  const typeName = typeMatch ? typeMatch[1]!.trim() || null : null;
  const seen = new Set<string>();
  const candidates: Array<{ path: string; size: number }> = [];
  let hasDcRuntime = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (DC_RUNTIME_LINE_RE.test(line)) {
      hasDcRuntime = true;
    }
    let candidate: string | null = null;
    const quoted = /"(project\/[^"\r\n]+)"/.exec(line);
    if (quoted) {
      candidate = quoted[1]!;
    } else {
      const unquoted =
        /(?:^|[\s`(*-])(project\/[^"'<>|\r\n]+?)(?=\s*\(\d|\s+—\s+|\s+\d+(?:\.\d+)?\s*(?:B|bytes?|KB|KiB|MB|MiB|GB|GiB)\b|["'`)\],;]|$)/.exec(
          line,
        );
      if (unquoted) candidate = unquoted[1]!.trim();
    }
    if (!candidate || !isSafeProjectPath(candidate)) continue;
    const sizeBytes = parseByteSize(line);
    if (sizeBytes !== null && sizeBytes > MAX_BINARY_BYTES && isBinaryFilePath(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push({ path: candidate, size: sizeBytes ?? 0 });
  }

  const selected: Array<{ path: string; size: number }> = [];
  let totalBytes = 0;
  let truncated = false;
  for (const c of candidates) {
    if (selected.length >= MAX_PROJECT_FILES || totalBytes + c.size > MAX_PROJECT_TOTAL_BYTES) {
      truncated = true;
      continue;
    }
    selected.push(c);
    totalBytes += c.size;
  }

  const canvas = candidates.find((c) => c.path === "project/canvas.json");
  if (canvas && !selected.some((s) => s.path === "project/canvas.json") && canvas.size <= MAX_PROJECT_TOTAL_BYTES) {
    while (
      selected.length > 0 &&
      (selected.length >= MAX_PROJECT_FILES || totalBytes + canvas.size > MAX_PROJECT_TOTAL_BYTES)
    ) {
      const popped = selected.pop()!;
      totalBytes -= popped.size;
    }
    if (selected.length < MAX_PROJECT_FILES && totalBytes + canvas.size <= MAX_PROJECT_TOTAL_BYTES) {
      selected.push(canvas);
    }
  }

  return { typeName, paths: selected.map((s) => s.path), truncated, hasDcRuntime };
}

export interface ParsedAssetEntry {
  id: string;
  sizeBytes: number | null;
}

/** Parse and cap asset entries (`^[0-9a-f]{32}$`, <=15 MB each, <=200 assets, <=80 MB total) from `list` scope `"assets"`. */
export function parseAssetsList(
  input: string | string[],
  structuredAssets?: Array<{ id?: unknown; size_bytes?: unknown }>,
): { assets: ParsedAssetEntry[]; truncated: boolean } {
  const texts = Array.isArray(input) ? input : [input];
  const seen = new Set<string>();
  const candidates: ParsedAssetEntry[] = [];

  const pushCandidate = (rawId: unknown, rawSize: number | null) => {
    if (typeof rawId !== "string") return;
    const id = rawId.trim();
    if (!ASSET_ID_RE.test(id)) return;
    if (rawSize !== null && rawSize > MAX_ASSET_BYTES) return;
    if (seen.has(id)) return;
    seen.add(id);
    candidates.push({ id, sizeBytes: rawSize });
  };

  if (Array.isArray(structuredAssets)) {
    for (const a of structuredAssets) {
      const size = typeof a?.size_bytes === "number" && Number.isFinite(a.size_bytes) ? a.size_bytes : null;
      pushCandidate(a?.id, size);
    }
  }

  for (const text of texts) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = /^[-*]?\s*["']?(?:\/_blob\/)?([0-9a-f]{32})["']?(?=$|[\s,;)(\]}])/.exec(line);
      if (!m) continue;
      pushCandidate(m[1]!, parseByteSize(line));
    }
  }

  const assets: ParsedAssetEntry[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const c of candidates) {
    const sz = c.sizeBytes ?? 0;
    if (assets.length >= MAX_ASSETS || totalBytes + sz > MAX_ASSETS_TOTAL_BYTES) {
      truncated = true;
      continue;
    }
    assets.push(c);
    totalBytes += sz;
  }
  return { assets, truncated };
}

function parseLeadingJson(text: string): any {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(0, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseDocsReadPayload(text: string): { title: string | null; files: Array<{ id: string; name: string }> } {
  const data = parseLeadingJson(text);
  if (!data) return { title: null, files: [] };
  const rawTitle =
    typeof data?.value?.name === "string"
      ? data.value.name
      : typeof data?.name === "string"
        ? data.name
        : null;
  const title = rawTitle?.trim() || null;
  const rawFiles = Array.isArray(data?.files)
    ? data.files
    : Array.isArray(data?.value?.files)
      ? data.value.files
      : [];
  const files: Array<{ id: string; name: string }> = [];
  for (const f of rawFiles) {
    const id = typeof f?.id === "string" ? f.id.trim() : f?.id !== undefined ? String(f.id).trim() : "";
    if (!id) continue;
    const name =
      typeof f?.name === "string" && f.name.trim()
        ? f.name.trim()
        : typeof f?.title === "string" && f.title.trim()
          ? f.title.trim()
          : id;
    files.push({ id, name });
  }
  return { title, files };
}

function extractExportMarkdown(text: string): string {
  const obj = parseLeadingJson(text);
  if (obj && typeof obj === "object") {
    const b64 = typeof obj?.data?.bytes_b64 === "string" ? obj.data.bytes_b64 : typeof obj?.bytes_b64 === "string" ? obj.bytes_b64 : null;
    if (b64 !== null) {
      return Buffer.from(b64, "base64").toString("utf-8");
    }
    for (const key of ["markdown", "content", "text", "value"]) {
      if (typeof obj?.[key] === "string") return obj[key];
      if (typeof obj?.data?.[key] === "string") return obj.data[key];
    }
  }
  return text;
}

function readTitleFromCanvasIndex(filesDir: string, savedFiles: Array<{ path: string; size: number }>): string | null {
  const canvas =
    savedFiles.find((f) => f.path === "project/canvas.json") ??
    savedFiles.find((f) => path.posix.basename(f.path) === "canvas.json");
  if (!canvas) return null;
  try {
    const raw = fs.readFileSync(path.join(filesDir, ...canvas.path.split("/")), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.title === "string" && parsed.title.trim() ? parsed.title.trim() : null;
  } catch {
    return null;
  }
}

function truncateUtf8(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, "utf-8") <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid), "utf-8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let out = str.slice(0, lo);
  // Avoid leaving a dangling high surrogate at the cut boundary.
  if (out.length > 0) {
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  }
  return out;
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

function claudeDocsArgs(prompt: string): string[] {
  return [
    "-p",
    "--tools",
    "",
    "--allowedTools",
    `ToolSearch,${DOCS_READ_TOOL},${DOCS_EXPORT_TOOL}`,
    "--permission-mode",
    "default",
    "--setting-sources",
    "project",
    "--output-format",
    "stream-json",
    "--verbose",
    prompt,
  ];
}

function failFromArtifactStream(id: string, out: SpawnOutput, parsed: ParsedStream): Artifact | null {
  if (out.timedOut) {
    return saveError(id, "read_failed", out.stderr.trim() || "Timed out reading artifact after 90s.");
  }
  const errToolRes = parsed.artifactToolResults.find((r) => r.isError) ?? (parsed.artifactToolResult?.isError ? parsed.artifactToolResult : null);
  if (errToolRes) {
    const classifyText = [errToolRes.text, parsed.finalResult?.text, out.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    const err = classify(classifyText);
    recordErrorAccountState(err);
    return saveError(id, err, errToolRes.text);
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

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function isFilesListResult(r: ToolCallResult): boolean {
  if (r.input?.scope === "files") return true;
  if (r.input?.scope === "assets") return false;
  if (/^Assets of /m.test(r.text) && !/\bproject\//.test(r.text)) return false;
  return true;
}

function isAssetsListResult(r: ToolCallResult): boolean {
  if (r.input?.scope === "assets") return true;
  if (r.input?.scope === "files") return false;
  return /^Assets of /m.test(r.text) || Boolean(r.structured?.asset_list);
}

function boardsReferenceSupportJs(filesDir: string, savedFiles: Array<{ path: string; size: number }>): boolean {
  for (const f of savedFiles) {
    if (!f.path.startsWith("project/") || !/\.(?:dc\.html|html|htm)$/i.test(f.path)) continue;
    try {
      const html = fs.readFileSync(path.join(filesDir, ...f.path.split("/")), "utf-8");
      if (html.includes("./support.js")) return true;
    } catch {}
  }
  return false;
}

function installDcRuntimeAsSupportJs(filesDir: string): boolean {
  const supportPath = path.join(filesDir, "project", "support.js");
  if (fs.existsSync(supportPath)) return true;
  const candidates = [path.join(filesDir, "artifact-type", "dc-runtime.js"), path.join(filesDir, "dc-runtime.js")];
  const src = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!src) return false;
  fs.mkdirSync(path.dirname(supportPath), { recursive: true });
  fs.copyFileSync(src, supportPath);
  fs.rmSync(path.join(filesDir, "artifact-type"), { recursive: true, force: true });
  fs.rmSync(path.join(filesDir, "dc-runtime.js"), { force: true });
  return true;
}

function hasSavedBlobAsset(blobDir: string, assetId: string): boolean {
  if (!ASSET_ID_RE.test(assetId) || !fs.existsSync(blobDir)) return false;
  try {
    return fs
      .readdirSync(blobDir, { withFileTypes: true })
      .some((ent) => !ent.isSymbolicLink() && ent.isFile() && (ent.name === assetId || ent.name.startsWith(`${assetId}.`)));
  } catch {
    return false;
  }
}

function enforceBlobCapsOnDisk(blobDir: string): void {
  if (!fs.existsSync(blobDir)) return;
  let kept = 0;
  let totalBytes = 0;
  try {
    const entries = fs.readdirSync(blobDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.isSymbolicLink() || !ent.isFile()) continue;
      const full = path.join(blobDir, ent.name);
      const size = fs.statSync(full).size;
      if (size > MAX_ASSET_BYTES || kept >= MAX_ASSETS || totalBytes + size > MAX_ASSETS_TOTAL_BYTES) {
        fs.rmSync(full, { force: true });
        continue;
      }
      kept++;
      totalBytes += size;
    }
  } catch {}
  if (kept === 0) {
    fs.rmSync(blobDir, { recursive: true, force: true });
  }
}

function buildProjectReadPrompt(url: string, filesDir: string, batches: string[][]): string {
  if (batches.length === 1) {
    return `Use the Artifact tool once with action "read", url ${JSON.stringify(url)}, paths ${JSON.stringify(batches[0])}, out_dir ${JSON.stringify(filesDir)}. Then reply with the single word done.`;
  }
  const batchLines = batches.map((b, i) => `batch ${i + 1}: paths ${JSON.stringify(b)}`).join("; ");
  return `Use the Artifact tool with action "read", url ${JSON.stringify(url)}, out_dir ${JSON.stringify(filesDir)} once for each of these paths arrays (do not skip any): ${batchLines}. Then reply with the single word done.`;
}

function buildSupportAndAssetsPrompt(
  url: string,
  filesDir: string,
  blobDir: string,
  includeRuntime: boolean,
  assetIds: string[],
): string {
  const safeIds = assetIds.filter((aid) => ASSET_ID_RE.test(aid));
  const parts: string[] = [];
  if (includeRuntime) {
    parts.push(
      `Use the Artifact tool with action "read", url ${JSON.stringify(url)}, path ${JSON.stringify(DC_RUNTIME_PATH)}, out_dir ${JSON.stringify(filesDir)}.`,
    );
  }
  if (safeIds.length > 0) {
    parts.push(
      `For each asset id in ${JSON.stringify(safeIds)}, use the Artifact tool with action "read", url ${JSON.stringify(url)}, path set to that asset id, out_dir ${JSON.stringify(blobDir)} (one call per asset id).`,
    );
  }
  parts.push("Then reply with the single word done.");
  return parts.join(" ");
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

  const existing = getArtifact(id);
  const pickTitle = (candidate?: string | null): string | undefined => {
    const existingTitle = existing?.title?.trim() ?? "";
    if (existingTitle && existingTitle !== "Untitled artifact") return undefined;
    const clean = candidate?.trim();
    return clean || undefined;
  };

  const outDir = path.join(home(), "artifacts", id);
  fs.mkdirSync(outDir, { recursive: true });
  const summaryPrompt = sanitizePrompt(opts?.prompt);

  // Step A: read metadata header (without path) to classify ownership and artifact type.
  const stepAPrompt = `Use the Artifact tool once with action "read", url ${JSON.stringify(parsedUrl.url)}, prompt ${JSON.stringify(summaryPrompt)} Then reply with the single word done.`;
  const outA = await runClaude(bin ?? "claude", claudeArtifactArgs(stepAPrompt), outDir, READ_TIMEOUT_MS);
  const parsedA = parseStreamOutput(outA.stdout);
  if (outA.timedOut || !parsedA.artifactToolResult || parsedA.artifactToolResult.isError) {
    return failFromArtifactStream(id, outA, parsedA);
  }

  const htmlPath = path.join(outDir, "index.html");
  if (parsedA.artifactToolResult.text.includes("File saved:") && fs.existsSync(htmlPath)) {
    accountState = "ok";
    return saveRead(id, {
      htmlPath,
      owner: "mine",
      typeName: null,
      contentKind: "html",
      contentPath: null,
      summary: null,
    });
  }

  const header = parseArtifactHeader(parsedA.artifactToolResult.text);
  const mappedIntent = intentFromType(header.typeName) ?? undefined;

  // Not owned -> keep the shared summary returned by Step A.
  if (!header.owned) {
    accountState = "ok";
    return saveRead(id, {
      summary: parsedA.artifactToolResult.text.slice(0, MAX_SUMMARY_CHARS),
      owner: "shared",
      typeName: header.typeName,
      intent: mappedIntent,
      contentKind: "summary",
      contentPath: null,
      htmlPath: null,
      title: pickTitle(header.title),
    });
  }

  // Owned, plain HTML page (no type) -> read index.html into outDir.
  if (!header.isTyped) {
    const htmlPrompt = `Use the Artifact tool once with action "read", url ${JSON.stringify(parsedUrl.url)}, path "index.html", out_dir ${JSON.stringify(outDir)}, prompt ${JSON.stringify(summaryPrompt)} Then reply with the single word done.`;
    const outHtml = await runClaude(bin ?? "claude", claudeArtifactArgs(htmlPrompt), outDir, READ_TIMEOUT_MS);
    const parsedHtml = parseStreamOutput(outHtml.stdout);
    if (outHtml.timedOut || !parsedHtml.artifactToolResult || parsedHtml.artifactToolResult.isError) {
      return failFromArtifactStream(id, outHtml, parsedHtml);
    }
    if (parsedHtml.artifactToolResult.text.includes("File saved:") && fs.existsSync(htmlPath)) {
      accountState = "ok";
      return saveRead(id, {
        htmlPath,
        owner: "mine",
        typeName: null,
        contentKind: "html",
        contentPath: null,
        summary: null,
        title: pickTitle(header.title),
      });
    }
    accountState = "ok";
    return saveRead(id, {
      summary: parsedHtml.artifactToolResult.text.slice(0, MAX_SUMMARY_CHARS),
      owner: "shared",
      typeName: null,
      contentKind: "summary",
      contentPath: null,
      htmlPath: null,
      title: pickTitle(header.title),
    });
  }

  // Owned Docs -> Step B via non-strict Claude Docs MCP connector.
  const isDocs = header.typeName?.toLowerCase() === "docs" || Boolean(header.docsId && !header.typeName);
  if (isDocs) {
    const docsId = header.docsId ?? header.artifactUuid;
    if (!docsId || !ARTIFACT_ID_RE.test(docsId)) {
      return saveError(id, "read_failed", "Could not determine valid Claude Docs id.");
    }

    const docsRef = JSON.stringify({ object: "project", id: docsId });
    const docsContainer = JSON.stringify({ kind: "project", id: docsId });
    const docsPrompt = [
      `Use ToolSearch to load ${DOCS_READ_TOOL} and ${DOCS_EXPORT_TOOL}.`,
      `Call ${DOCS_READ_TOOL} with ref ${docsRef}.`,
      `Then for each item in files[], call ${DOCS_EXPORT_TOOL} with container ${docsContainer}, file set to that tab's id, and format "markdown".`,
      "Reply with only the word done, print nothing else.",
    ].join(" ");

    const outB = await runClaude(bin ?? "claude", claudeDocsArgs(docsPrompt), outDir, READ_TIMEOUT_MS);
    if (outB.timedOut) {
      return saveError(id, "read_failed", outB.stderr.trim() || "Timed out reading Claude Docs after 90s.");
    }
    const parsedB = parseStreamOutput(outB.stdout);
    if (parsedB.toolUses.some((t) => !ALLOWED_DOCS_TOOLS.has(t.name))) {
      return saveError(id, "read_failed", DOCS_DISALLOWED_TOOL_ERROR);
    }
    const rawB = [parsedB.finalResult?.text, ...parsedB.assistantTexts, outB.stderr.trim()]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (classify(rawB) === "usage_limit") {
      recordErrorAccountState("usage_limit");
      return saveError(id, "usage_limit", rawB);
    }
    if (
      parsedB.initTools !== null &&
      (!parsedB.initTools.includes(DOCS_READ_TOOL) || !parsedB.initTools.includes(DOCS_EXPORT_TOOL))
    ) {
      return saveError(id, "read_failed", DOCS_NOT_CONNECTED_ERROR);
    }

    const readRes = parsedB.toolResults.find(
      (r) =>
        r.name === DOCS_READ_TOOL &&
        (r.input?.ref?.id === docsId || r.input?.container?.id === docsId),
    );
    if (!readRes) {
      const err = classify(rawB);
      recordErrorAccountState(err);
      return saveError(id, err, rawB || "Failed to read Claude Docs project.");
    }
    if (readRes.isError) {
      const err = classify([readRes.text, rawB].filter(Boolean).join("\n"));
      recordErrorAccountState(err);
      return saveError(id, err, readRes.text);
    }

    const { title: docTitle, files: tabs } = parseDocsReadPayload(readRes.text);
    const exportResults = parsedB.toolResults.filter(
      (r) =>
        r.name === DOCS_EXPORT_TOOL &&
        r.input?.container?.id === docsId &&
        r.input?.format === "markdown",
    );
    const failedExport = exportResults.find((r) => r.isError);
    if (failedExport && exportResults.every((r) => r.isError)) {
      const err = classify([failedExport.text, rawB].filter(Boolean).join("\n"));
      recordErrorAccountState(err);
      return saveError(id, err, failedExport.text);
    }

    const byTabId = new Map<string, string>();
    const orderedExports: string[] = [];
    for (const exp of exportResults) {
      if (exp.isError) continue;
      const md = extractExportMarkdown(exp.text);
      orderedExports.push(md);
      const tabId = typeof exp.input?.file === "string" ? exp.input.file.trim() : "";
      if (tabId) byTabId.set(tabId, md);
    }

    const headingTitle = docTitle || header.title || existing?.title || "Untitled artifact";
    const sections: string[] = [`# ${headingTitle}`];
    const failedTabNames: string[] = [];
    if (tabs.length > 0) {
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i]!;
        const md = byTabId.get(tab.id) ?? (byTabId.size === 0 ? orderedExports[i] : undefined);
        if (md !== undefined) {
          sections.push(`## ${tab.name}\n\n${md.trim()}`);
        } else {
          failedTabNames.push(tab.name);
        }
      }
    } else if (orderedExports.length > 0) {
      for (const md of orderedExports) {
        sections.push(md.trim());
      }
      for (const exp of exportResults) {
        if (!exp.isError) continue;
        const tabName = typeof exp.input?.file === "string" && exp.input.file.trim() ? exp.input.file.trim() : "unknown";
        failedTabNames.push(tabName);
      }
    }

    if (sections.length <= 1 && orderedExports.length === 0) {
      return saveError(id, "read_failed", "No exported markdown returned from Claude Docs.");
    }

    if (failedTabNames.length > 0) {
      sections.push(`> Some tabs could not be read: ${failedTabNames.join(", ")}`);
    }

    const rawMd = `${sections.join("\n\n")}\n`;
    const contentMd =
      Buffer.byteLength(rawMd, "utf-8") > MAX_CONTENT_BYTES
        ? `${truncateUtf8(rawMd, MAX_CONTENT_BYTES - Buffer.byteLength(CONTENT_TRUNCATED_NOTE, "utf-8"))}${CONTENT_TRUNCATED_NOTE}`
        : rawMd;
    const mdPath = path.join(outDir, "content.md");
    fs.writeFileSync(mdPath, contentMd, "utf-8");

    accountState = "ok";
    const effectiveType = header.typeName ?? "Docs";
    return saveRead(id, {
      owner: "mine",
      typeName: effectiveType,
      intent: intentFromType(effectiveType) ?? "document",
      contentKind: "markdown",
      contentPath: mdPath,
      htmlPath: null,
      summary: null,
      title: pickTitle(docTitle || header.title),
    });
  }

  // Owned, files-based typed artifact (Design, Slides, Data, Whiteboard, Design System, ...).
  const listPrompt = [
    `Use the Artifact tool with action "list", scope "files", url ${JSON.stringify(parsedUrl.url)}.`,
    `Also use the Artifact tool with action "list", scope "assets", url ${JSON.stringify(parsedUrl.url)} (if the assets output indicates more pages or a cursor, keep calling action "list", scope "assets" until all assets up to ${MAX_ASSETS} are listed).`,
    "Reply with the single word done.",
  ].join(" ");
  const outList = await runClaude(bin ?? "claude", claudeArtifactArgs(listPrompt), outDir, READ_TIMEOUT_MS);
  const parsedList = parseStreamOutput(outList.stdout);
  const filesListResult =
    parsedList.artifactToolResults.filter(isFilesListResult).at(-1) ?? parsedList.artifactToolResult;
  if (outList.timedOut || !filesListResult || filesListResult.isError) {
    return failFromArtifactStream(id, outList, parsedList);
  }

  const listed = parseFilesList(filesListResult.text);
  const safePaths = listed.paths.filter(isSafeProjectPath);
  const effectiveType = header.typeName ?? listed.typeName;
  if (safePaths.length === 0) {
    return saveError(id, "read_failed", "No project/ files found in artifact.");
  }

  if (!ARTIFACT_ID_RE.test(id)) {
    return saveError(id, "read_failed", "Invalid artifact id.");
  }
  const filesDir = path.join(outDir, "files");
  fs.rmSync(filesDir, { recursive: true, force: true });
  fs.mkdirSync(filesDir, { recursive: true });
  const truncMarker = path.join(outDir, FILES_TRUNCATED_MARKER);
  if (listed.truncated) {
    fs.writeFileSync(truncMarker, "1", "utf-8");
  } else {
    fs.rmSync(truncMarker, { force: true });
  }

  const pathBatches = chunkArray(safePaths, READ_BATCH_SIZE);
  const filesPrompt = buildProjectReadPrompt(parsedUrl.url, filesDir, pathBatches);
  const filesTimeout = pathBatches.length > 1 ? BATCH_READ_TIMEOUT_MS : READ_TIMEOUT_MS;
  const outFiles = await runClaude(bin ?? "claude", claudeArtifactArgs(filesPrompt), filesDir, filesTimeout);
  const parsedFiles = parseStreamOutput(outFiles.stdout);
  const fileResults = parsedFiles.artifactToolResults;
  if (
    outFiles.timedOut ||
    fileResults.length === 0 ||
    (fileResults.every((r) => r.isError) && parsedFiles.artifactToolResult?.isError)
  ) {
    return failFromArtifactStream(id, outFiles, parsedFiles);
  }

  // If Claude used `paths` arrays and skipped any batch, run one follow-up pass for remaining files.
  if (fileResults.some((r) => Array.isArray(r.input?.paths))) {
    const coveredPaths = new Set<string>();
    for (const r of fileResults) {
      if (r.isError || !Array.isArray(r.input?.paths)) continue;
      for (const p of r.input.paths) {
        if (typeof p === "string") coveredPaths.add(p);
      }
    }
    const missingPaths = safePaths.filter(
      (p) => !coveredPaths.has(p) && !fs.existsSync(path.join(filesDir, ...p.split("/"))),
    );
    if (missingPaths.length > 0) {
      const retryBatches = chunkArray(missingPaths, READ_BATCH_SIZE);
      const retryPrompt = buildProjectReadPrompt(parsedUrl.url, filesDir, retryBatches);
      await runClaude(bin ?? "claude", claudeArtifactArgs(retryPrompt), filesDir, BATCH_READ_TIMEOUT_MS);
    }
  }

  const savedProjectFiles = listArtifactFiles(filesDir);
  if (savedProjectFiles.length === 0) {
    return saveError(id, "read_failed", "Artifact files were not saved.");
  }

  const needSupportJs =
    listed.hasDcRuntime &&
    !fs.existsSync(path.join(filesDir, "project", "support.js")) &&
    boardsReferenceSupportJs(filesDir, savedProjectFiles);

  const assetResults = parsedList.artifactToolResults.filter((r) => !r.isError && isAssetsListResult(r));
  const structuredAssets = assetResults.flatMap((r) =>
    Array.isArray(r.structured?.asset_list?.assets) ? r.structured.asset_list.assets : [],
  );
  let assetsListed = parseAssetsList(
    assetResults.map((r) => r.text),
    structuredAssets,
  );

  // Follow pagination cursor once if the assets list indicates more pages and we are still under the cap.
  const lastAssetList = assetResults.at(-1);
  const nextCursor =
    typeof lastAssetList?.structured?.asset_list?.next_cursor === "string"
      ? lastAssetList.structured.asset_list.next_cursor.trim()
      : null;
  if (nextCursor && !assetsListed.truncated && assetsListed.assets.length < MAX_ASSETS) {
    const pagePrompt = `Use the Artifact tool with action "list", scope "assets", url ${JSON.stringify(parsedUrl.url)}, starting after cursor ${JSON.stringify(nextCursor)} (continue paging if more pages exist, up to ${MAX_ASSETS} assets). Reply with the single word done.`;
    const outPage = await runClaude(bin ?? "claude", claudeArtifactArgs(pagePrompt), outDir, READ_TIMEOUT_MS);
    const parsedPage = parseStreamOutput(outPage.stdout);
    const moreResults = parsedPage.artifactToolResults.filter((r) => !r.isError && isAssetsListResult(r));
    if (moreResults.length > 0) {
      const allResults = [...assetResults, ...moreResults];
      const allStructured = allResults.flatMap((r) =>
        Array.isArray(r.structured?.asset_list?.assets) ? r.structured.asset_list.assets : [],
      );
      assetsListed = parseAssetsList(
        allResults.map((r) => r.text),
        allStructured,
      );
    }
  }

  const assetIds = assetsListed.assets.map((a) => a.id).filter((aid) => ASSET_ID_RE.test(aid));
  if (needSupportJs || assetIds.length > 0) {
    const blobDir = path.join(filesDir, "_blob");
    if (assetIds.length > 0) {
      fs.mkdirSync(blobDir, { recursive: true });
    }
    const assetChunks = assetIds.length > 0 ? chunkArray(assetIds, ASSET_READ_RUN_SIZE) : [[]];
    let runtimePending = needSupportJs;

    for (const chunk of assetChunks) {
      let pendingIds = [...chunk];
      for (let attempt = 0; attempt < 2 && (runtimePending || pendingIds.length > 0); attempt++) {
        const prompt = buildSupportAndAssetsPrompt(parsedUrl.url, filesDir, blobDir, runtimePending, pendingIds);
        const outExtra = await runClaude(
          bin ?? "claude",
          claudeArtifactArgs(prompt),
          filesDir,
          pendingIds.length > 5 ? BATCH_READ_TIMEOUT_MS : READ_TIMEOUT_MS,
        );
        if (runtimePending && installDcRuntimeAsSupportJs(filesDir)) {
          runtimePending = false;
        }
        const parsedExtra = parseStreamOutput(outExtra.stdout);
        const attemptedPaths = new Set<string>();
        for (const r of parsedExtra.artifactToolResults) {
          if (typeof r.input?.path === "string") attemptedPaths.add(r.input.path);
        }
        // Only retry asset ids that are missing on disk and were not even attempted by the tool.
        pendingIds = pendingIds.filter(
          (aid) => !hasSavedBlobAsset(blobDir, aid) && (attemptedPaths.size > 0 ? !attemptedPaths.has(aid) : false),
        );
        if (outExtra.timedOut) break;
      }
    }
    enforceBlobCapsOnDisk(blobDir);
  }

  const savedFiles = listArtifactFiles(filesDir);
  const canvasTitle = readTitleFromCanvasIndex(filesDir, savedFiles);
  accountState = "ok";
  return saveRead(id, {
    owner: "mine",
    typeName: effectiveType,
    intent: intentFromType(effectiveType) ?? undefined,
    contentKind: "files",
    contentPath: filesDir,
    htmlPath: null,
    summary: null,
    title: pickTitle(header.title || canvasTitle),
  });
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
  if (parsed.artifactToolResult) {
    if (parsed.artifactToolResult.isError) {
      const classifyText = [parsed.artifactToolResult.text, parsed.finalResult?.text, out.stderr.trim()]
        .filter(Boolean)
        .join("\n");
      recordErrorAccountState(classify(classifyText));
      return { account: getAccount(), updated: 0 };
    }

    let updated = 0;
    const stmt = db().prepare(
      "UPDATE artifacts SET title = ?, owner = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL",
    );
    for (const line of parsed.artifactToolResult.text.split(/\r?\n/)) {
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
