/**
 * Pure helpers for the Specs views: the shapes the daemon sends, the pipeline stepper's states, task
 * filtering, and the little formatters. No React here, so it is all unit-tested.
 */

export type FeatureStatus = "draft" | "planned" | "tasked" | "in-progress" | "done";
export type StepName = "constitution" | "specify" | "clarify" | "plan" | "tasks" | "analyze" | "implement";
export type AttachMode = "ref" | "inline";

export interface FeatureInfo {
  id: string;
  number: string;
  name: string;
  dir: string;
  title: string;
  files: { spec: boolean; plan: boolean; tasks: boolean; research: boolean; dataModel: boolean; quickstart: boolean; contracts: string[]; other: string[] };
  tasks: { done: number; total: number };
  status: FeatureStatus;
  updatedAt: number;
  specDraft: boolean;
  clarifications: number;
}

export interface SpecsOverview {
  constitution: { exists: boolean; path: string; bytes: number; placeholders: boolean; mtime: number | null };
  features: FeatureInfo[];
  specify: { path: string | null };
  numbering: "sequential" | "timestamp";
  rev: string;
}

export interface SpecTask {
  line: number;
  id: string | null;
  done: boolean;
  parallel: boolean;
  story: string | null;
  text: string;
  file: string | null;
  phase: string | null;
  group: string | null;
  indent: number;
}

export interface ParsedTasks {
  tasks: SpecTask[];
  phases: Array<{ title: string; tasks: SpecTask[] }>;
  total: number;
  done: number;
  malformed: Array<{ line: number; text: string }>;
}

export interface SessionSpec {
  session_id: string;
  spec_path: string;
  mode: AttachMode;
  purpose: "context" | "architecture" | "implement" | "head" | "step";
  delivered: boolean;
  state: string | null;
}

export const CONSTITUTION_PATH = ".specify/memory/constitution.md";

export const STEPS: Array<{ id: StepName; label: string; hint: string }> = [
  { id: "constitution", label: "Constitution", hint: "The principles every feature is built under" },
  { id: "specify", label: "Specify", hint: "What the feature does and why, with no implementation detail" },
  { id: "clarify", label: "Clarify", hint: "Settle the open questions that would change the plan" },
  { id: "plan", label: "Plan", hint: "How it will be built: approach, structure, data, contracts" },
  { id: "tasks", label: "Tasks", hint: "An ordered checklist with exact file paths" },
  { id: "analyze", label: "Analyze", hint: "A read-only consistency review of spec, plan and tasks" },
  { id: "implement", label: "Implement", hint: "Work through the tasks until every box is ticked" },
];

export type StepState = "done" | "active" | "ready" | "blocked";

export interface StepView {
  id: StepName;
  label: string;
  hint: string;
  state: StepState;
  /** Why it is blocked, or what "done" means for it. */
  note: string;
}

/**
 * Where a feature stands in the workflow. `active` is the first step that is not done and can run: the one
 * the stepper highlights. Clarify and analyze are never required, so they never block what follows them.
 */
export function pipeline(o: SpecsOverview | undefined, f: FeatureInfo | null): StepView[] {
  const constitutionDone = !!o?.constitution.exists && !o.constitution.placeholders;
  const specDone = !!f?.files.spec && !f.specDraft;
  const planDone = !!f?.files.plan;
  const tasksDone = !!f && f.tasks.total > 0;
  const allDone = !!f && f.tasks.total > 0 && f.tasks.done === f.tasks.total;

  const raw: Array<{ id: StepName; done: boolean; blocked: string | null; note: string }> = [
    { id: "constitution", done: constitutionDone, blocked: null, note: !o?.constitution.exists ? "Not written yet" : o.constitution.placeholders ? "Still has [PLACEHOLDER]s" : "Written" },
    { id: "specify", done: specDone, blocked: f ? null : "Pick or create a feature", note: !f ? "No feature selected" : specDone ? "spec.md is filled in" : "spec.md is still the skeleton" },
    { id: "clarify", done: specDone && f!.clarifications === 0, blocked: !f ? "Pick or create a feature" : !f.files.spec ? "Specify first" : null, note: !f ? "" : f.clarifications > 0 ? `${f.clarifications} open question${f.clarifications === 1 ? "" : "s"}` : specDone ? "No open questions" : "Optional" },
    { id: "plan", done: planDone, blocked: !f ? "Pick or create a feature" : !f.files.spec ? "Specify first" : null, note: planDone ? "plan.md exists" : "No plan.md yet" },
    { id: "tasks", done: tasksDone, blocked: !f ? "Pick or create a feature" : !f.files.plan ? "Plan first" : null, note: !f ? "" : tasksDone ? `${f.tasks.total} tasks` : "No tasks.md yet" },
    { id: "analyze", done: false, blocked: !f ? "Pick or create a feature" : !f.files.spec ? "Specify first" : null, note: "A read-only review, run it any time" },
    { id: "implement", done: allDone, blocked: !f ? "Pick or create a feature" : !f.files.tasks || f.tasks.total === 0 ? "Generate the tasks first" : null, note: !f ? "" : allDone ? "Every task is done" : f.tasks.total ? `${f.tasks.done}/${f.tasks.total} done` : "" },
  ];

  // Required steps decide "active"; clarify and analyze are skipped over, and so is the constitution once
  // there is a feature to work on (it is written up front, but nothing waits on it).
  const optional = new Set<StepName>(f ? ["constitution", "clarify", "analyze"] : ["clarify", "analyze"]);
  const active = raw.find((r) => !r.done && !r.blocked && !optional.has(r.id))?.id ?? null;
  return raw.map((r) => {
    const meta = STEPS.find((s) => s.id === r.id)!;
    const state: StepState = r.done ? "done" : r.blocked ? "blocked" : r.id === active ? "active" : "ready";
    return { id: r.id, label: meta.label, hint: meta.hint, state, note: r.blocked && !r.done ? r.blocked : r.note };
  });
}

/** Badge tone per feature status. */
export function statusTone(s: FeatureStatus): "neutral" | "blue" | "violet" | "amber" | "green" {
  return s === "done" ? "green" : s === "in-progress" ? "amber" : s === "tasked" ? "violet" : s === "planned" ? "blue" : "neutral";
}

export const statusLabel = (s: FeatureStatus): string => (s === "in-progress" ? "in progress" : s);

export const percent = (done: number, total: number): number => (total > 0 ? Math.round((done / total) * 100) : 0);

/** "1.2k" style, for token counts. */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
}

/** Tone of an attachment's token cost: what it adds to every new session's first turn. */
export function costTone(tokens: number): "ok" | "warn" | "high" {
  return tokens >= 8000 ? "high" : tokens >= 2000 ? "warn" : "ok";
}

export interface DocTab {
  id: "spec" | "plan" | "tasks" | "research" | "data-model" | "contracts" | "quickstart";
  label: string;
  /** The file this tab shows (contracts: the first one). null: it does not exist yet. */
  path: string | null;
  exists: boolean;
}

/** The tabs of the workbench, in workflow order. A tab for a file that does not exist is still shown, dimmed. */
export function docTabs(f: FeatureInfo): DocTab[] {
  const p = (name: string) => `${f.dir}/${name}`;
  return [
    { id: "spec", label: "Spec", path: p("spec.md"), exists: f.files.spec },
    { id: "plan", label: "Plan", path: p("plan.md"), exists: f.files.plan },
    { id: "tasks", label: "Tasks", path: p("tasks.md"), exists: f.files.tasks },
    { id: "research", label: "Research", path: p("research.md"), exists: f.files.research },
    { id: "data-model", label: "Data model", path: p("data-model.md"), exists: f.files.dataModel },
    { id: "contracts", label: "Contracts", path: f.files.contracts[0] ? p(f.files.contracts[0]) : null, exists: f.files.contracts.length > 0 },
    { id: "quickstart", label: "Quickstart", path: p("quickstart.md"), exists: f.files.quickstart },
  ];
}

/** The step that creates a given doc, for the empty state of a missing tab. */
export const STEP_FOR_DOC: Partial<Record<DocTab["id"], StepName>> = { spec: "specify", plan: "plan", tasks: "tasks", research: "plan", "data-model": "plan", contracts: "plan", quickstart: "plan" };

export interface TaskFilter {
  query: string;
  hideDone: boolean;
  onlyParallel: boolean;
}

export function filterTasks(tasks: SpecTask[], f: TaskFilter): SpecTask[] {
  const q = f.query.trim().toLowerCase();
  return tasks.filter((t) => {
    if (f.hideDone && t.done) return false;
    if (f.onlyParallel && !t.parallel) return false;
    if (!q) return true;
    return `${t.id ?? ""} ${t.story ?? ""} ${t.text} ${t.phase ?? ""}`.toLowerCase().includes(q);
  });
}

export interface PhaseView {
  title: string;
  tasks: SpecTask[];
  done: number;
  total: number;
}

/** Tasks grouped by phase, keeping file order; phases with no visible task are dropped. */
export function groupByPhase(tasks: SpecTask[], all: SpecTask[]): PhaseView[] {
  const totals = new Map<string, { done: number; total: number }>();
  for (const t of all) {
    const k = t.phase ?? "Tasks";
    const x = totals.get(k) ?? { done: 0, total: 0 };
    x.total++;
    if (t.done) x.done++;
    totals.set(k, x);
  }
  const out: PhaseView[] = [];
  for (const t of tasks) {
    const k = t.phase ?? "Tasks";
    let g = out.find((p) => p.title === k);
    if (!g) {
      const tot = totals.get(k)!;
      g = { title: k, tasks: [], done: tot.done, total: tot.total };
      out.push(g);
    }
    g.tasks.push(t);
  }
  return out;
}

/** The first open phase: the one the checklist opens by default. */
export function currentPhase(phases: PhaseView[]): string | null {
  return phases.find((p) => p.done < p.total)?.title ?? phases[0]?.title ?? null;
}

/** "specs/001-orders-export" → "001 orders-export"; the constitution → "Constitution"; a file → its name. */
export function attachLabel(path: string): string {
  if (path === CONSTITUTION_PATH) return "Constitution";
  const m = /^specs\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (m) {
    const id = m[1].replace(/^(\d{8}-\d{6}|\d{3,})-/, "$1 ");
    return m[2] ? `${id} · ${m[2]}` : id;
  }
  return path.split("/").pop() ?? path;
}

/** Which feature a path belongs to, if any. */
export const featureOfPath = (path: string): string | null => /^specs\/([^/]+)/.exec(path)?.[1] ?? null;

/** The question a step asks before it runs, when it needs a sentence from the user. */
export function stepInputLabel(step: StepName): string | null {
  switch (step) {
    case "constitution":
      return "Anything the principles must cover (optional)";
    case "specify":
      return "What should this feature do? (optional: the spec already has the request)";
    case "clarify":
      return "A topic to focus on (optional)";
    case "plan":
      return "Technical direction, if you have one (optional)";
    case "tasks":
      return "Anything about ordering or splitting (optional)";
    case "analyze":
      return "A concern to look into (optional)";
    case "implement":
      return "Anything to keep in mind while building (optional)";
  }
}

/** A readable "2 minutes ago" for the feature list. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** A feature name for the new-feature field → the folder it will get (mirrors the daemon, for the live preview). */
export function previewSlug(input: string): string {
  const stop = new Set(["a", "an", "the", "to", "for", "of", "and", "in", "on", "with"]);
  const words = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const keep = words.filter((w) => !stop.has(w));
  return (keep.length ? keep : words).slice(0, 5).join("-").slice(0, 48).replace(/-+$/, "");
}

export interface RunChoice {
  where: "new" | "current";
  engine: string;
  model: string;
  agent: string;
  pairId: string;
  input: string;
  test: string;
  parallel: boolean;
  asHead: boolean;
}

export const emptyRun = (): RunChoice => ({ where: "new", engine: "", model: "", agent: "", pairId: "", input: "", test: "", parallel: false, asHead: false });

/** The request body for a run, leaving out everything left at its default. */
export function runPayload(c: RunChoice, sessionId: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.where === "current" && sessionId) out.sessionId = sessionId;
  else {
    if (c.engine) out.engine = c.engine;
    if (c.model) out.model = c.model;
    if (c.agent) out.agent = c.agent;
    if (c.pairId) out.pairId = c.pairId;
  }
  if (c.input.trim()) out.input = c.input.trim();
  if (c.test.trim()) out.test = c.test.trim();
  if (c.parallel) out.parallel = true;
  if (c.asHead) out.asHead = true;
  return out;
}

/** The number the next feature will get, for the new-feature preview (the daemon decides for real). */
export function nextNumber(o: SpecsOverview | undefined): string {
  if (o?.numbering === "timestamp") return "YYYYMMDD-HHMMSS";
  let max = 0;
  for (const f of o?.features ?? []) if (/^\d{3,}$/.test(f.number)) max = Math.max(max, Number(f.number));
  return String(max + 1).padStart(3, "0");
}
