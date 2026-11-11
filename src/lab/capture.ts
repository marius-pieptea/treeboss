/**
 * Logs a bug reported from the built-in browser by a person, or from the agent's browser by a QA agent (qa/tools.ts
 * bug_log): gathers the screenshot, console and server log, stores them as evidence, and writes the finding.
 */
import fs from "fs";
import { HttpError } from "../daemon/http";
import { listInstances, readLogs } from "../devserver/manager";
import { addEvidence, type EvidenceItem } from "../evidence/store";
import { readIssues } from "../preview/issues";
import { shootViewport } from "../preview/shot";
import { redact, stripQueryValues } from "../search/redact";
import { BUG_KINDS, createBugFinding, type BugKind, type Finding, type ShotKind } from "./findings";

/** `agent`: a PNG the agent's own browser took of the page it was on. */
export type ShotIn = { kind: "desktop"; png: Buffer } | { kind: "agent"; png: Buffer } | { kind: "rerender"; viewport: { width: number; height: number } } | { kind: "none" };

export interface BugReport {
  title: string;
  kind: BugKind;
  /** The operator-edited lines, in order, without numbering. */
  steps: string[];
  expected: string;
  actual: string;
  /** Loopback http(s) only. The address as sent: it may carry secrets, so it is only ever shown to the re-render, never stored. */
  url: string;
  port: number | null;
  shot: ShotIn;
  attach: { console: boolean; logs: boolean };
  /** Console lines the caller already has (the agent browser's), used instead of the preview's. */
  consoleLines?: string[];
  /** Logged by a QA agent: the finding is marked found_by: agent and starts unconfirmed. */
  byAgent?: boolean;
}

export interface LoggedBug {
  finding: Finding;
  capture: EvidenceItem | null;
  /** Why the screenshot is not the one asked for, when it is not. */
  shotNote: string | null;
}

export const MAX_PNG_BYTES = 15 * 1024 * 1024;
export const MAX_BUG_TITLE = 200;
export const MAX_BUG_NOTE = 10_000;
export const MAX_BUG_STEPS = 50;
export const MAX_BUG_STEP = 300;
export const EXCERPT_BYTES = 4096;
export const LOG_LINES = 400;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const bad = (msg: string): never => {
  throw new HttpError(400, msg);
};

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function viewportOf(v: unknown): { width: number; height: number } {
  const w = isObj(v) ? v.width : NaN;
  const h = isObj(v) ? v.height : NaN;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return bad("shot.viewport needs a positive width and height.");
  return { width: Math.round(w), height: Math.round(h) };
}

function shotOf(v: unknown): ShotIn {
  if (v === undefined || v === null) return { kind: "none" };
  if (!isObj(v)) return bad("shot must be an object.");
  if (v.kind === "none") return { kind: "none" };
  if (v.kind === "rerender") return { kind: "rerender", viewport: viewportOf(v.viewport) };
  if (v.kind !== "desktop") return bad('shot.kind must be "desktop", "rerender" or "none".');
  const b64 = typeof v.png === "string" ? v.png.replace(/^data:image\/png;base64,/, "") : "";
  if (!b64) return bad("shot.png is missing.");
  if (b64.length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 4) return bad(`The screenshot is over ${MAX_PNG_BYTES / 1024 / 1024} MB.`);
  if (b64.length % 4 !== 0 || !BASE64.test(b64)) return bad("shot.png is not valid base64.");
  const png = Buffer.from(b64, "base64");
  if (png.length > MAX_PNG_BYTES) return bad(`The screenshot is over ${MAX_PNG_BYTES / 1024 / 1024} MB.`);
  if (png.length < PNG_MAGIC.length || !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return bad("shot.png is not a PNG.");
  return { kind: "desktop", png };
}

function stepsOf(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return bad("steps must be a list of text lines.");
  const lines = v.map((x: string) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (lines.length > MAX_BUG_STEPS) return bad(`A bug takes at most ${MAX_BUG_STEPS} steps.`);
  if (lines.some((l) => l.length > MAX_BUG_STEP)) return bad(`A step is over ${MAX_BUG_STEP} characters.`);
  return lines;
}

export function parseBugReport(body: unknown): BugReport {
  if (!isObj(body)) return bad("Body must be a JSON object.");
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return bad("A bug needs a title.");
  if (title.length > MAX_BUG_TITLE) return bad(`The title is over ${MAX_BUG_TITLE} characters.`);
  const kind = body.kind === undefined || body.kind === null ? "functional" : (BUG_KINDS as readonly unknown[]).includes(body.kind) ? (body.kind as BugKind) : bad(`kind must be one of ${BUG_KINDS.join(", ")}.`);
  const text = (key: string, label: string): string => {
    const v = body[key];
    const out = v === undefined || v === null ? "" : typeof v === "string" ? v.trim() : bad(`${key} must be text.`);
    if (out.length > MAX_BUG_NOTE) return bad(`The ${label} is over ${MAX_BUG_NOTE} characters.`);
    return out;
  };
  const expected = text("expected", "expected result");
  const actual = text("actual", "description") || text("note", "note");
  const steps = stepsOf(body.steps);
  let u: URL;
  try {
    u = new URL(typeof body.url === "string" ? body.url : "");
  } catch {
    return bad("url must be an address.");
  }
  if (!/^https?:$/.test(u.protocol) || !LOOPBACK.has(u.hostname)) return bad("Only http(s) pages on this machine (localhost) can be logged.");
  let port: number | null = null;
  if (body.port !== undefined && body.port !== null) {
    if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) return bad("port must be 1-65535.");
    port = body.port;
  } else if (u.port) port = Number(u.port);
  const attach = isObj(body.attach) ? body.attach : {};
  return { title, kind, steps, expected, actual, url: u.toString(), port, shot: shotOf(body.shot), attach: { console: attach.console !== false, logs: attach.logs !== false } };
}

/** The end of a line that alone exceeds the cap, from a UTF-8 boundary: the error text is usually last. */
function tailOf(line: string): string {
  const buf = Buffer.from(line);
  let start = buf.length - (EXCERPT_BYTES - 1 - Buffer.byteLength("…"));
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return "…" + buf.subarray(start).toString();
}

/** The last lines that fit in `EXCERPT_BYTES`, redacted, with how many made it. */
export function excerpt(lines: string[]): { text: string; count: number } {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = redact(lines[i]!);
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > EXCERPT_BYTES && kept.length) break;
    kept.unshift(bytes > EXCERPT_BYTES ? tailOf(line) : line);
  }
  return { text: kept.join("\n"), count: kept.length };
}

function consoleLines(port: number | null): string[] {
  if (port === null) return [];
  return readIssues(port).map((i) => `[${new Date(i.ts).toISOString().slice(11, 19)}] ${i.level}${i.page ? ` ${i.page}` : ""}: ${i.text}`);
}

function serverOf(rootDir: string, port: number | null) {
  if (port === null) return null;
  const all = listInstances(rootDir);
  return all.find((i) => i.port === port && i.kind === "dev") ?? all.find((i) => i.port === port) ?? null;
}

export interface CaptureDeps {
  shoot: typeof shootViewport;
  write: typeof createBugFinding;
}

async function screenshot(r: BugReport, deps: CaptureDeps): Promise<{ png: Buffer | null; kind: ShotKind; note: string | null; viewport?: { width: number; height: number } }> {
  if (r.shot.kind === "desktop" || r.shot.kind === "agent") return { png: r.shot.png, kind: r.shot.kind, note: null };
  if (r.shot.kind === "none") return { png: null, kind: "none", note: null };
  const shot = await deps.shoot({ url: r.url, viewport: r.shot.viewport });
  if ("error" in shot) return { png: null, kind: "none", note: `The page could not be re-rendered for a screenshot: ${shot.error}` };
  try {
    const png = fs.readFileSync(shot.path);
    fs.rmSync(shot.path, { force: true });
    return { png, kind: "rerender", note: null, viewport: r.shot.viewport };
  } catch (e: any) {
    return { png: null, kind: "none", note: `The re-rendered screenshot could not be read: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

export async function logBug(rootDir: string, r: BugReport, deps: CaptureDeps = { shoot: shootViewport, write: createBugFinding }): Promise<LoggedBug> {
  const issues = !r.attach.console ? [] : r.consoleLines ?? consoleLines(r.port);
  const server = r.attach.logs ? serverOf(rootDir, r.port) : null;
  const logs = server ? readLogs(rootDir, server.service, 0, LOG_LINES).lines.map((l) => (l.stream === "sys" ? `[trb] ${l.text}` : l.text)) : [];
  const shot = await screenshot(r, deps);
  const url = stripQueryValues(r.url);

  const files: Record<string, string | Buffer> = {};
  if (shot.png) files["screenshot.png"] = shot.png;
  if (issues.length) files["console.txt"] = redact(`${issues.join("\n")}\n`);
  if (logs.length) files["server.log"] = redact(`${logs.join("\n")}\n`);
  let capture: EvidenceItem | null = null;
  if (Object.keys(files).length) {
    files["meta.json"] = JSON.stringify({ url, ...(shot.viewport ? { viewport: shot.viewport } : {}), shot: shot.kind, ...(server ? { service: server.service } : {}) }, null, 2);
    capture = addEvidence({ workspace: rootDir, kind: "bug", title: r.title, url, summary: r.actual, files, source: r.byAgent ? "agent" : "operator" });
  }

  const con = excerpt(issues);
  const log = excerpt(logs);
  const section = (head: string, text: string) => (text ? `## ${head}\n\n${text}` : "");
  const steps = section("Steps to reproduce", redact(r.steps.map((l, i) => `${i + 1}. ${l}`).join("\n")));
  const expected = section("Expected", r.expected);
  const actual = section("Actual", r.actual);
  const body = [steps || expected || actual ? "" : r.title, steps, expected, actual, con.count ? `## Console (last ${con.count})\n\n\`\`\`\n${con.text}\n\`\`\`` : "", log.count ? `## Server log (last ${log.count})\n\n\`\`\`\n${log.text}\n\`\`\`` : ""].filter(Boolean).join("\n\n");
  const finding = deps.write(rootDir, { title: r.title, body, bug: { url, capture: capture?.id ?? null, shot: shot.kind, kind: r.kind, ...(r.byAgent ? { by: "agent" as const, confirmed: false } : {}) }, impact: "medium", effort: "s" });
  return { finding, capture, shotNote: shot.note };
}
