/**
 * Grok, Cursor and Codex plan windows, read the way OpenBot reads them.
 * Grok: `_x.ai/billing` on a short `grok agent stdio` session (the CLI uses its own sign-in).
 * Cursor: the dashboard calls the Cursor CLI sends, with the token in its auth file.
 * Codex: the newest rollout JSONL under `~/.codex/sessions`, whose `token_count` events carry `rate_limits`.
 * The token is not logged or stored. A miss is cached so a sidebar poll does not retry at once.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { killTree } from "../proctree";
import { ENGINES, resolveBinary } from "./registry";
import { getLimits, mergeWindows, parseCodexRateLimits, storeWindows, type LimitWindow } from "./limits";

/** shortcut: at most one read per 5 minutes, including a miss, so hovering does not spawn grok or call Cursor every time. */
const REFRESH_MS = 5 * 60_000;
const GROK_TIMEOUT_MS = 12_000;
const CURSOR_TIMEOUT_MS = 10_000;
/** Rollouts can pass 100 MB, so the newest `token_count` is found from the tail first. */
const CODEX_TAIL_START = 256 * 1024;
const CODEX_TAIL_MAX = 8 * 1024 * 1024;

const attempted = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();

const clamp = (n: number): number => Math.max(0, Math.min(100, n));
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const near = (mins: number, target: number): boolean => Math.abs(mins - target) <= target * 0.05;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function titleFor(mins: number | null): { id: string; title: string } {
  if (mins === null || !Number.isFinite(mins)) return { id: "limit", title: "Limit" };
  if (near(mins, 10_080)) return { id: "weekly", title: "Weekly" };
  if (near(mins, 43_200) || near(mins, 40_320)) return { id: "monthly", title: "Monthly" };
  if (near(mins, 1_440)) return { id: "daily", title: "Daily" };
  if (near(mins, 300)) return { id: "five_hour", title: "5-hour" };
  if (mins >= 60 && mins % 60 === 0) return { id: `hours_${mins / 60}`, title: `${mins / 60}-hour` };
  const rounded = Math.round(mins);
  return { id: `minutes_${rounded}`, title: `${rounded} min` };
}

function windowOf(id: string, title: string, used: number, resetsAt: number | null, now: number): LimitWindow {
  return { id, title, percent: Math.round(clamp(used) * 10) / 10, resets_at: resetsAt, status: "allowed", at: now };
}

/** `undefined` when the field is absent, `null` when it is malformed. A missing `val` is 0 (proto3 JSON). */
function grokCent(config: Record<string, unknown>, key: string): number | null | undefined {
  if (config[key] === undefined) return undefined;
  const cent = asRecord(config[key]);
  if (!cent) return null;
  if (cent.val === undefined) return 0;
  return finite(cent.val);
}

/**
 * A period with no `creditUsagePercent` and no `monthlyLimit` above $0 is 0% used.
 * Proto3 JSON omits a zero scalar, which is what the Grok CLI itself treats as zero.
 */
function grokCreditUsagePercent(config: Record<string, unknown>): number | null {
  if (config.creditUsagePercent !== undefined) {
    const n = finite(config.creditUsagePercent);
    return n === null ? null : clamp(n);
  }
  const limit = grokCent(config, "monthlyLimit");
  if (limit === undefined || limit === 0) return 0;
  const used = grokCent(config, "used");
  if (limit === null || limit < 0 || used === null) return null;
  return clamp(((used ?? 0) / limit) * 100);
}

/** One window from `_x.ai/billing`. Empty when the payload has no period or no usable percent. */
export function parseGrokBilling(value: unknown, now = Math.floor(Date.now() / 1000)): LimitWindow[] {
  const config = asRecord(asRecord(value)?.config);
  const period = asRecord(config?.currentPeriod);
  if (!config || !period) return [];
  const used = grokCreditUsagePercent(config);
  if (used === null) return [];
  const start = Date.parse(typeof period.start === "string" ? period.start : "");
  const end = Date.parse(typeof period.end === "string" ? period.end : "");
  const durationMins = Number.isFinite(start) && Number.isFinite(end) ? (end - start) / 60_000 : Number.NaN;
  const periodType = typeof period.type === "string" ? period.type : typeof period.periodType === "string" ? period.periodType : "";
  const weekly = periodType ? periodType.toLowerCase().includes("weekly") : near(durationMins, 10_080);
  const mins = Number.isFinite(durationMins) ? durationMins : weekly ? 10_080 : null;
  const named = titleFor(mins);
  return [windowOf(named.id, named.title, used, Number.isFinite(end) ? end / 1_000 : null, now)];
}

function millis(v: unknown): number | null {
  if (typeof v === "string" && v.trim()) v = Number(v);
  return finite(v);
}

/**
 * Cursor's billing cycle. Two percents are "Cursor models" and "Other models".
 * A merged plan, or a plan that only sends the total, is one window named by the cycle length.
 */
export function parseCursorUsage(usage: unknown, planInfo: unknown, now = Math.floor(Date.now() / 1000)): LimitWindow[] {
  const body = asRecord(usage);
  const plan = asRecord(body?.planUsage);
  if (!body || !plan) return [];
  const start = millis(body.billingCycleStart);
  const end = millis(body.billingCycleEnd);
  const mins = start !== null && end !== null && end > start ? Math.round((end - start) / 60_000) : null;
  const resetsAt = end !== null ? end / 1_000 : null;
  const named = titleFor(mins);
  const auto = finite(plan.autoPercentUsed);
  const api = finite(plan.apiPercentUsed);
  const total = finite(plan.totalPercentUsed);
  const merged = asRecord(planInfo)?.isMerged === true;
  const split = !merged && (auto !== null || api !== null);
  const out: LimitWindow[] = [];
  if (split) {
    if (auto !== null) out.push(windowOf("cursor_models", "Cursor models", auto, resetsAt, now));
    if (api !== null) out.push(windowOf("other_models", "Other models", api, resetsAt, now));
  } else if (total !== null) {
    out.push(windowOf(named.id, named.title, total, resetsAt, now));
  }
  return out;
}

function cursorAuthFile(): string {
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Cursor", "auth.json");
  if (process.platform === "darwin") return join(homedir(), ".cursor", "auth.json");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cursor", "auth.json");
}

async function cursorToken(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(cursorAuthFile(), "utf8")) as { accessToken?: unknown };
    return typeof parsed.accessToken === "string" && parsed.accessToken ? parsed.accessToken : null;
  } catch {
    return null;
  }
}

async function postDashboard(path: string, accessToken: string): Promise<unknown | null> {
  const endpoint = (process.env.CURSOR_API_ENDPOINT?.trim() || "https://api2.cursor.sh").replace(/\/+$/u, "");
  try {
    const response = await fetch(`${endpoint}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(CURSOR_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403 || !response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function readCursorWindows(now = Math.floor(Date.now() / 1000)): Promise<LimitWindow[]> {
  const accessToken = await cursorToken();
  if (!accessToken) return [];
  const [usage, planInfo] = await Promise.all([
    postDashboard("/aiserver.v1.DashboardService/GetCurrentPeriodUsage", accessToken),
    postDashboard("/aiserver.v1.DashboardService/GetPlanInfo", accessToken),
  ]);
  if (usage === null) return [];
  return parseCursorUsage(usage, planInfo, now);
}

interface CodexReading {
  rateLimits: unknown;
  /** Epoch seconds from the rollout line's own top-level timestamp. */
  at: number | null;
}

const codexEpoch = (timestamp: unknown): number | null => {
  if (typeof timestamp !== "string") return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/** Newest `.jsonl` anywhere under `dir`; fallback for a sessions tree that is not YYYY/MM/DD. */
async function newestJsonl(dir: string): Promise<string | null> {
  let newest: string | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(path);
          if (info.mtimeMs > newestAt) {
            newestAt = info.mtimeMs;
            newest = path;
          }
        } catch {}
      }
    }
  };
  await walk(dir);
  return newest;
}

/** Newest `.jsonl` directly in one day directory. */
async function newestIn(dir: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: string | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(dir, entry.name);
    try {
      const info = await stat(path);
      if (info.mtimeMs > newestAt) {
        newestAt = info.mtimeMs;
        newest = path;
      }
    } catch {}
  }
  return newest;
}

/** The newest rollout under the codex sessions tree, or null when codex never ran here. */
async function newestCodexRollout(root: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = (list: typeof entries, pattern: RegExp) =>
    list.filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => entry.name).sort().reverse();
  for (const year of dirs(entries, /^\d{4}$/)) {
    const yearPath = join(root, year);
    let months;
    try {
      months = await readdir(yearPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const month of dirs(months, /^\d{2}$/)) {
      const monthPath = join(yearPath, month);
      let days;
      try {
        days = await readdir(monthPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const day of dirs(days, /^\d{2}$/)) {
        const found = await newestIn(join(monthPath, day));
        if (found) return found;
      }
    }
  }
  return newestJsonl(root);
}

async function mtimeSeconds(path: string): Promise<number | null> {
  try {
    return Math.floor((await stat(path)).mtimeMs / 1000);
  } catch {
    return null;
  }
}

/** The newest `rate_limits` in a rollout, reading its tail first because rollouts can be very large. */
async function lastCodexRateLimits(path: string): Promise<CodexReading | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    for (let want = Math.min(size, CODEX_TAIL_START); ; want = Math.min(size, want * 2)) {
      const start = Math.max(0, size - want);
      const buf = Buffer.alloc(want);
      await handle.read(buf, 0, want, start);
      const lines = buf.toString("utf8").split("\n");
      // The first line is cut unless the read reached the start of the file.
      for (let i = lines.length - 1; i >= (start > 0 ? 1 : 0); i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        for (const inner of [asRecord(event?.payload), asRecord(event)]) {
          if (inner?.type === "token_count" && asRecord(inner.rate_limits)) return { rateLimits: inner.rate_limits, at: codexEpoch(event?.timestamp) };
        }
      }
      if (start === 0 || want >= CODEX_TAIL_MAX) return null;
    }
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Codex plan windows from its newest rollout's latest `token_count` event. */
export async function readCodexWindows(now = Math.floor(Date.now() / 1000), root = join(homedir(), ".codex", "sessions")): Promise<LimitWindow[]> {
  const path = await newestCodexRollout(root);
  if (!path) return [];
  const reading = await lastCodexRateLimits(path);
  if (!reading) return [];
  return parseCodexRateLimits(reading.rateLimits, reading.at ?? (await mtimeSeconds(path)) ?? now);
}

function stopChild(child: ChildProcess): void {
  try {
    if (process.platform === "win32") killTree(child.pid, "SIGKILL");
    else child.kill();
  } catch {}
}

/** Ask a freshly started `grok agent stdio` for its billing period, then stop it. */
export function readGrokWindows(bin: string, now = Math.floor(Date.now() / 1000)): Promise<LimitWindow[]> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--no-auto-update", "agent", "stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env });
    child.stderr?.resume();
    let settled = false;
    let buffer = "";
    let nextId = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const failPending = (reason: string) => {
      for (const waiter of pending.values()) waiter.reject(new Error(reason));
      pending.clear();
    };
    const done = (windows: LimitWindow[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      failPending("closed");
      stopChild(child);
      resolve(windows);
    };
    const timer = setTimeout(() => done([]), GROK_TIMEOUT_MS);
    const send = (msg: Record<string, unknown>) => {
      try { child.stdin?.write(JSON.stringify(msg) + "\n"); } catch {}
    };
    const request = (method: string, params: Record<string, unknown>) => new Promise((ok, bad) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject: bad });
      send({ jsonrpc: "2.0", id, method, params });
    });
    const onLine = (line: string) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && typeof msg.method === "string") {
        const allow = Array.isArray(msg.params?.options) ? msg.params.options[0] : null;
        if (msg.method === "session/request_permission") {
          send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId ?? allow?.id ?? "allow" } } });
        } else {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not implemented" } });
        }
        return;
      }
      if (msg.id === undefined) return;
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(typeof msg.error?.message === "string" ? msg.error.message : "ACP error"));
      else waiter.resolve(msg.result);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) onLine(line);
      }
    });
    child.on("error", () => done([]));
    child.on("exit", () => done([]));
    void (async () => {
      try {
        const init = await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "treeboss", version: "0" },
        }) as { authMethods?: Array<{ id?: string }> };
        const methods = init?.authMethods ?? [];
        const prefer = process.env.XAI_API_KEY?.trim() ? "xai.api_key" : "cached_token";
        const selected = methods.find((method) => method?.id === prefer) ?? methods.find((method) => method?.id === "cached_token");
        if (selected?.id) await request("authenticate", { methodId: selected.id });
        done(parseGrokBilling(await request("_x.ai/billing", {}), now));
      } catch {
        done([]);
      }
    })();
  });
}

/** Refresh one engine when its snapshot is older than the cache. Failures keep the previous windows. */
export async function refreshReportedLimits(engine: string): Promise<void> {
  if (engine !== "grok" && engine !== "cursor" && engine !== "codex") return;
  const nowMs = Date.now();
  const snap = getLimits(engine, Math.floor(nowMs / 1000));
  if (snap.updated_at && nowMs / 1000 - snap.updated_at < REFRESH_MS / 1000) return;
  if (nowMs - (attempted.get(engine) ?? 0) < REFRESH_MS) return;
  const existing = inflight.get(engine);
  if (existing) return existing;
  const job = (async () => {
    attempted.set(engine, Date.now());
    try {
      const now = Math.floor(Date.now() / 1000);
      const bin = engine === "grok" ? resolveBinary(ENGINES.grok) : null;
      if (engine === "grok" && !bin) return;
      const windows = engine === "cursor" ? await readCursorWindows(now) : engine === "codex" ? await readCodexWindows(now) : await readGrokWindows(bin!, now);
      if (engine === "codex") mergeWindows(engine, windows);
      else if (windows.length) storeWindows(engine, windows);
    } catch {
      // The last snapshot stays. The cache above keeps a dead CLI from being asked on every hover.
    }
  })();
  inflight.set(engine, job);
  try { await job; } finally { inflight.delete(engine); }
}
