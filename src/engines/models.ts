/**
 * The model catalog: what models each engine can run, so a model is chosen from a list instead of typed
 * from memory.
 *
 * Every engine except claude can say which models it offers (cursor `--list-models`, opencode `models`, codex
 * `debug models`, grok and agy `models`); claude gets a short built-in list. The CLIs are slow (seconds) and some
 * need the network, so results are cached in memory and on disk for hours and refreshed on request. A list is only
 * ever a convenience: a model id the catalog has not heard of is still accepted everywhere, because a new model
 * ships before any list notices it.
 */
import fs from "fs";
import path from "path";
import { home } from "../paths";
import { runCmd } from "../git/run";
import { getEngine, resolveBinary } from "./registry";

export interface ModelInfo {
  id: string;
  label: string;
  /** Provider or family, to group a long list (opencode lists hundreds). */
  group?: string;
  hint?: string;
  /** The engine's own default. */
  default?: boolean;
  /** Reasoning levels this model supports, when the engine says (codex does). */
  efforts?: string[];
}

export interface ModelCatalog {
  engine: string;
  /** cli: asked the engine just now or recently. static: built in (the engine cannot list its models). */
  source: "cli" | "static";
  models: ModelInfo[];
  /** Effort levels the engine accepts, for the effort dropdown. */
  efforts: string[];
  fetchedAt: string;
  /** Why a live list is missing (not installed, not signed in, timed out); the static list is shown instead. */
  error?: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const LIST_TIMEOUT_MS = 25_000;

/** What `--effort` / its equivalent accepts per engine. Engines absent here have no effort control. */
const EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  fake: ["low", "medium", "high"],
  codex: ["low", "medium", "high"],
  grok: ["low", "medium", "high"],
  opencode: ["minimal", "low", "medium", "high", "max"],
};

export function effortsFor(engine: string): string[] {
  return EFFORTS[engine] ?? [];
}

/** claude cannot list its models. Aliases track the newest of a family; full ids pin one. */
const CLAUDE_STATIC: ModelInfo[] = [
  { id: "opus", label: "Opus (latest)", group: "Aliases", hint: "newest Opus" },
  { id: "sonnet", label: "Sonnet (latest)", group: "Aliases", hint: "newest Sonnet" },
  { id: "haiku", label: "Haiku (latest)", group: "Aliases", hint: "newest Haiku" },
  { id: "claude-fable-5-1", label: "Fable 5.1", group: "Claude" },
  { id: "claude-opus-5-5", label: "Opus 5.5", group: "Claude" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", group: "Claude" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", group: "Claude" },
];

/* ---------------------------------------------------------------- parsers */

export function parseCursorModels(out: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of out.split("\n")) {
    const m = /^([A-Za-z0-9][\w.\-[\]=,]*) - (.+)$/.exec(line.trim());
    if (!m) continue;
    const isDefault = /\(current, default\)|\(default\)/.test(m[2]);
    const label = m[2].replace(/\s*\((?:current, )?default\)/, "").replace(/\s*\(current\)/, "");
    models.push({ id: m[1], label, ...(isDefault ? { default: true } : {}) });
  }
  return models;
}

export function parseOpencodeModels(out: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of out.split("\n")) {
    const id = line.trim();
    const m = /^([\w.-]+)\/(.+)$/.exec(id);
    if (!m) continue;
    models.push({ id, label: m[2], group: m[1] });
  }
  return models;
}

/** grok: `* id (default)` and `- id` lines under "Available models:". */
export function parseGrokModels(out: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  let inList = false;
  for (const line of out.split("\n")) {
    if (/^Available models:/i.test(line.trim())) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const m = /^\s*([*-])\s+(\S+)(?:\s+\((default)\))?/.exec(line);
    if (m) models.push({ id: m[2], label: m[2], ...(m[1] === "*" || m[3] ? { default: true } : {}) });
  }
  return models;
}

/** agy: tab-separated `id<TAB>Label` after a "Fetching…" line. */
export function parseAgyModels(out: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of out.split("\n")) {
    const [id, label] = line.split("\t");
    if (!id || !label || /\s/.test(id)) continue;
    models.push({ id, label, group: label.replace(/\s*\(.*\)\s*$/, "") });
  }
  return models;
}

/** codex: JSON catalog with each model's supported reasoning levels. Hidden models are left out. */
export function parseCodexModels(out: string): ModelInfo[] {
  let data: any;
  try {
    data = JSON.parse(out);
  } catch {
    return [];
  }
  return (Array.isArray(data?.models) ? data.models : [])
    .filter((m: any) => m && typeof m.slug === "string" && (m.visibility === undefined || m.visibility === "list"))
    .map((m: any): ModelInfo => ({
      id: m.slug,
      label: m.display_name || m.slug,
      hint: typeof m.description === "string" ? m.description : undefined,
      efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l: any) => String(l.effort)).filter(Boolean) : undefined,
    }));
}

const SOURCES: Record<string, { args: string[]; parse: (out: string) => ModelInfo[] }> = {
  cursor: { args: ["--list-models"], parse: parseCursorModels },
  opencode: { args: ["models"], parse: parseOpencodeModels },
  codex: { args: ["debug", "models"], parse: parseCodexModels },
  grok: { args: ["models"], parse: parseGrokModels },
  agy: { args: ["models"], parse: parseAgyModels },
};

/* ------------------------------------------------------------------ cache */

const memory = new Map<string, ModelCatalog>();
const inflight = new Map<string, Promise<ModelCatalog>>();

function cacheFile(): string {
  return path.join(home(), "models-cache.json");
}

function readDisk(): Record<string, ModelCatalog> {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf-8"));
  } catch {
    return {};
  }
}

function writeDisk(engine: string, cat: ModelCatalog): void {
  try {
    const all = readDisk();
    all[engine] = cat;
    fs.writeFileSync(cacheFile(), JSON.stringify(all));
  } catch {}
}

function fresh(cat: ModelCatalog | undefined): cat is ModelCatalog {
  return !!cat && Date.now() - Date.parse(cat.fetchedAt) < TTL_MS;
}

function staticCatalog(engine: string, error?: string): ModelCatalog {
  return { engine, source: "static", models: engine === "claude" ? CLAUDE_STATIC : [], efforts: effortsFor(engine), fetchedAt: new Date().toISOString(), ...(error ? { error } : {}) };
}

async function fetchCatalog(engine: string): Promise<ModelCatalog> {
  const src = SOURCES[engine];
  if (!src) return staticCatalog(engine);
  const def = getEngine(engine);
  const bin = def ? resolveBinary(def) : null;
  if (!bin) return staticCatalog(engine, `${def?.label ?? engine} is not installed.`);
  const r = await runCmd(bin, src.args, { cwd: home(), timeoutMs: LIST_TIMEOUT_MS, env: { NO_COLOR: "1", CI: "true" } });
  if (r.timedOut) return staticCatalog(engine, `${def!.label} did not list its models in ${LIST_TIMEOUT_MS / 1000}s.`);
  const models = src.parse(r.stdout.toString("utf-8"));
  if (r.code !== 0 || models.length === 0) {
    const why = (r.stderr.toString("utf-8") || r.stdout.toString("utf-8")).trim().split("\n")[0]?.slice(0, 200);
    return staticCatalog(engine, why || `${def!.label} listed no models (are you signed in?).`);
  }
  // Per-model efforts (codex) widen the engine-level list.
  const efforts = [...new Set([...effortsFor(engine), ...models.flatMap((m) => m.efforts ?? [])])];
  return { engine, source: "cli", models, efforts, fetchedAt: new Date().toISOString() };
}

/** The catalog for an engine: cached for hours; `refresh` asks the CLI again. Never throws. */
export async function listModels(engine: string, opts: { refresh?: boolean } = {}): Promise<ModelCatalog> {
  if (!opts.refresh) {
    const mem = memory.get(engine);
    if (fresh(mem)) return mem;
    const disk = readDisk()[engine];
    if (fresh(disk) && disk.source === "cli") {
      memory.set(engine, disk);
      return disk;
    }
  }
  let p = inflight.get(engine);
  if (!p) {
    p = fetchCatalog(engine)
      .then((cat) => {
        // A failed live fetch must not evict a good older list: keep serving that, flagged with the error.
        const prev = memory.get(engine) ?? readDisk()[engine];
        if (cat.source === "static" && cat.error && prev?.source === "cli") return { ...prev, error: cat.error };
        memory.set(engine, cat);
        if (cat.source === "cli") writeDisk(engine, cat);
        return cat;
      })
      .finally(() => inflight.delete(engine));
    inflight.set(engine, p);
  }
  return p;
}

/** Test seam. */
export function clearModelCache(): void {
  memory.clear();
  inflight.clear();
  try {
    fs.rmSync(cacheFile(), { force: true });
  } catch {}
}
