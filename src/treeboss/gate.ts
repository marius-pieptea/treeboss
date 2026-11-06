/**
 * The treeboss gate: after a turn of a session in treeboss mode, the rules in rules.ts are checked against the files
 * that turn changed. A broken rule goes back to the agent as a fix turn, at most twice in a row; then the gate stops
 * and says so in the log.
 *
 * Which files changed: the checkpoints. Every turn ends with a snapshot of the working tree (checkpoints/store.ts),
 * so a turn's changes are the diff between its snapshot and the one before it (`checkpointBefore`). That is one
 * `git diff` between two tree objects git already holds: no scan of the working tree, no snapshot of its own, and
 * new, changed and deleted files alike. Its one blind spot: edits the operator made between two turns are in the
 * diff too. Outside a git repository there are no checkpoints, so the gate logs that and checks nothing.
 *
 * The tier comes from the text the agent wrote in the turn (every text block, not only the final answer), unless the
 * operator set one (store.ts). Every turn the gate looks at ends with a `last_check` record in the store: what it
 * checked, which rules passed, failed or did not apply, and what it did about it. The UI reads that record.
 *
 * The enabled practice packs (src/practices) are checked on the same files. In fix mode their findings join the same fix turn;
 * in warn they are only logged. Outside treeboss mode the verify step runs them instead (src/verify/loop.ts).
 *
 * research/ is the area tier's scratch (the candidates page for the operator's pick): it is not checked as built work.
 *
 * Order at the end of a turn (see sessions/manager.ts): specs ticks, docs, this, then verify and the goal. When this
 * sends a fix turn, verify and the goal wait for that turn to end. Never throws: a bug here must not take a session down.
 */
import fs from "fs";
import path from "path";
import { db } from "../db";
import { turnChangesOf, type Changes } from "../checkpoints/changes";

export { parseDiff, type AddedLine, type Changes } from "../checkpoints/changes";
import { docsDirForSession } from "../docs/attach";
import { roadmapPath } from "../roadmap/store";
import { listAttached } from "../specs/attach";
import { SPECS_DIR } from "../specs/templates";
import { practiceLine, practiceRun } from "../practices/checks";
import { Hub } from "../sessions/hub";
import { appendLog, getSession, send, type SessionRecord } from "../sessions/manager";
import { CANDIDATES_FILE } from "./research";
import { bumpAttempts, getState, isTreeboss, resetAttempts, setLastCheck, setTier, type CheckId, type CheckOutcome, type CheckResult, type Tier } from "./store";

export const MAX_FIX_ATTEMPTS = 2;
/** The first line of every fix turn. A turn whose prompt carries it is one the gate sent, so it keeps the count. */
export const FIX_HEADER = "## Treeboss gate:";

const SCRATCH = `${path.dirname(CANDIDATES_FILE)}/`;
const SPEC_ROOTS = [SPECS_DIR, ".specify"];
const CHECK_IDS: CheckId[] = ["design", "spec", "roadmap", "docs"];

/* -------------------------------------------------------------------------- */
/* Pure checks                                                                */
/* -------------------------------------------------------------------------- */

const TIER_LINE = /^[ \t`*]*TREEBOSS_TIER:[ \t`*]*(tweak|feature|area)\b/gim;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * The text outside fenced code blocks (``` or ~~~, as markdown reads them). A tier line quoted inside a code sample
 * is not the agent's statement, and the web's display skips the same lines, so the two agree.
 */
export function outsideFences(text: string): string {
  const kept: string[] = [];
  let open: { char: string; len: number } | null = null;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line);
    if (open) {
      // A closing fence uses the same character, at least as many of them, and nothing else on its line.
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === open.char && close[1]!.length >= open.len) open = null;
      continue;
    }
    if (f) {
      open = { char: f[1]![0]!, len: f[1]!.length };
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** The tier the agent stated outside code blocks. The last statement wins, so a task that changes tier can say so. */
export function parseTier(output: string): Tier | null {
  let tier: Tier | null = null;
  for (const m of outsideFences(output).matchAll(TIER_LINE)) tier = m[1]!.toLowerCase() as Tier;
  return tier;
}

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9A-Za-z_-])/g;

/** Hex color literals in a line or a file, lower-cased (#rgb, #rrggbb, #rrggbbaa). */
export function hexLiterals(text: string): string[] {
  return [...text.matchAll(HEX)].map((m) => m[0].toLowerCase());
}

export const isTest = (file: string): boolean => /(^|\/)(tests?|__tests__)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
const UI_FILE = /\.(tsx|jsx|css|scss|html|vue|svelte)$/i;
const SOURCE_FILE = /\.(tsx|jsx|ts|js|mjs|cjs|css|scss|html|vue|svelte|py|go|rs|rb|java|kt|swift|cs|php|c|cc|cpp|h|hpp)$/i;
export const isUi = (file: string): boolean => UI_FILE.test(file) && !isTest(file);
export const isSource = (file: string): boolean => SOURCE_FILE.test(file) && !isTest(file);

/** Hex colors added to UI files that design/tokens.css does not define. The caller reads the tokens file. */
export function designViolations(changes: Changes, tokensCss: string): string[] {
  const known = new Set(hexLiterals(tokensCss));
  const out: string[] = [];
  for (const a of changes.added) {
    if (!isUi(a.file)) continue;
    for (const hex of hexLiterals(a.text)) if (!known.has(hex)) out.push(`${a.file}:${a.line} uses ${hex}, which is not a token in design/tokens.css`);
  }
  return out;
}

/** Feature and area changes to source must come with a doc: a page in the docs folder, or a root *.md such as README.md. */
export function docsViolation(tier: Tier, files: string[], docsDir: string): string | null {
  if (tier === "tweak") return null;
  const source = files.filter(isSource);
  if (!source.length) return null;
  const dir = `${docsDir.replace(/\/+$/, "")}/`;
  if (files.some((f) => f.startsWith(dir) || (!f.includes("/") && /\.md$/i.test(f)))) return null;
  return `${source.length} source file${source.length === 1 ? "" : "s"} changed (${source.slice(0, 4).join(", ")}${source.length > 4 ? ", …" : ""}), but no doc was updated. Update the page under ${dir} or the root README.md that describes this behavior.`;
}

/** Feature and area changes need a spec: one attached to the session, or a change under specs/ or .specify/. */
export function specViolation(tier: Tier, files: string[], attached: number): string | null {
  if (tier === "tweak" || attached > 0) return null;
  if (files.some((f) => SPEC_ROOTS.some((r) => f.startsWith(`${r}/`)))) return null;
  return `This is a ${tier}, but no spec is attached to the session and no file under ${SPECS_DIR}/ or .specify/ changed. Create it with the \`spec_new\` tool (name, description), then attach it with \`spec_attach\` (path).`;
}

/**
 * Feature and area changes come with a ROADMAP.md item, so the roadmap file must change in the turn. `roadmapFile` is
 * relative to the session's directory, the same as `files`.
 */
export function roadmapViolation(tier: Tier, files: string[], roadmapFile: string): string | null {
  if (tier === "tweak" || files.includes(roadmapFile)) return null;
  return `This is a ${tier}, but ${roadmapFile} did not change. Propose its item with the \`roadmap_propose\` tool: the title, and the spec path as \`spec\` once you have one. The tool creates ${roadmapFile} when it is missing.`;
}

/** What the agent is told. Long lists are cut: the first fix usually clears the rest. */
export function fixPrompt(violations: string[], attempt: number): string {
  const shown = violations.slice(0, 20);
  const more = violations.length - shown.length;
  return [
    `${FIX_HEADER} your last turn did not meet the rules (fix ${attempt} of ${MAX_FIX_ATTEMPTS})`,
    "",
    "The gate checks the files that turn changed. These did not pass:",
    ...shown.map((v) => `- ${v}`),
    ...(more > 0 ? [`- and ${more} more`] : []),
    "",
    "Fix them, then finish anything left of the original task. The gate checks again after your reply, so end it with the outcome of the whole task: what was built, and what the fixes changed.",
    "If a rule does not apply to this change, say which one and why in that reply.",
  ].join("\n");
}

export { practiceLine };

/** One rule's verdict on a turn: a skip with its reason, or the violations it found (none when it passed). */
export interface Check {
  id: CheckId;
  skip: string | null;
  violations: string[];
}

const checkOf = (id: CheckId, violation: string | null): Check => ({ id, skip: null, violations: violation ? [violation] : [] });
const skipped = (id: CheckId, reason: string): Check => ({ id, skip: reason, violations: [] });

export function checkResult(c: Check): CheckResult {
  if (c.skip) return { id: c.id, status: "skip", detail: c.skip };
  if (c.violations.length) return { id: c.id, status: "fail", detail: c.violations.join("; ") };
  return { id: c.id, status: "pass", detail: null };
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

const note = (s: SessionRecord, turnId: string | null, text: string) => appendLog(s, turnId, `[treeboss] ${text}`, "info");

/** Every text block the agent wrote in one turn, in order: the tier line can sit in any of them, not only the final answer. */
export function assistantTextOf(turnId: string): string {
  const rows = db().prepare("SELECT text FROM events WHERE turn_id = ? AND kind = 'text' ORDER BY id").all(turnId) as Array<{ text: string }>;
  return rows.map((r) => r.text).join("\n");
}

/** The turn's changes, or the reason they could not be read (which is also logged). */
async function changesOf(s: SessionRecord, turnId: string, seq: number): Promise<Changes | string> {
  const r = await turnChangesOf(s, turnId, seq);
  if (typeof r === "string") note(s, turnId, r);
  return r;
}

/** The workspace's roadmap file, relative to its root: the same relative path the diff uses in the session's directory. */
const roadmapFileOf = (s: SessionRecord): string => roadmapPath(s.base_cwd);

const readOr = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "");

/** Writes the turn's record and tells the web, which reads it from the session view. */
function record(s: SessionRecord, turnId: string | null, tier: Tier | null, outcome: CheckOutcome, checks: CheckResult[]): void {
  setLastCheck(s.id, { turn_id: turnId, at: new Date().toISOString(), tier, outcome, checks });
  Hub.publish({ type: "state", sessionId: s.id, rootId: s.root_id, status: getSession(s.id)?.status ?? s.status });
}

/** A turn the gate did not check: every rule is skipped, and the reason is the detail. */
const uncheckedChecks = (reason: string): CheckResult[] => CHECK_IDS.map((id) => ({ id, status: "skip", detail: reason }));

/**
 * Called when a turn has settled. Returns `continued: true` when it sent a fix turn.
 * Never throws: bookkeeping must not fail a turn.
 */
export async function treebossAfterTurn(sessionId: string, info: { interrupted: boolean; success: boolean; turnId?: string }): Promise<{ continued: boolean }> {
  try {
    const s = getSession(sessionId);
    if (!s || s.status === "closed" || !isTreeboss(sessionId)) return { continued: false };
    const turnId = info.turnId ?? s.last_turn_id;
    // Another turn started while the earlier hooks ran: this turn is no longer the one to check, and that turn writes its own record.
    if (info.turnId && s.last_turn_id !== info.turnId) return { continued: false };
    if (info.interrupted || !info.success) {
      const why = info.interrupted ? "the turn was interrupted, so it was not checked." : "the turn failed, so it was not checked.";
      record(s, turnId, getState(sessionId).tier, "not_checked", uncheckedChecks(why));
      return { continued: false };
    }
    const turn = turnId ? (db().prepare("SELECT seq, output, prompt FROM turns WHERE id = ?").get(turnId) as { seq: number; output: string | null; prompt: string } | undefined) : undefined;
    if (!turnId || !turn) {
      record(s, turnId, getState(sessionId).tier, "not_checked", uncheckedChecks("the turn has no record, so it was not checked."));
      return { continued: false };
    }

    // A fix turn the gate sent keeps the count of the chain; any other turn starts it over.
    if (!turn.prompt.includes(FIX_HEADER)) resetAttempts(sessionId);
    // An operator's tier wins inside setTier (it does nothing then), so the stored tier is the one in force.
    const said = parseTier(assistantTextOf(turnId)) ?? parseTier(turn.output ?? "");
    if (said) setTier(sessionId, said);
    const tier: Tier = getState(sessionId).tier ?? "feature";

    const read = await changesOf(s, turnId, turn.seq);
    if (typeof read === "string") {
      record(s, turnId, tier, "not_checked", uncheckedChecks(read));
      return { continued: false };
    }
    const built: Changes = {
      files: read.files.filter((f) => !f.startsWith(SCRATCH)),
      added: read.added.filter((a) => !a.file.startsWith(SCRATCH)),
    };
    // A turn that built nothing (a question, a plan, an answer) has nothing to check.
    if (!built.files.length) {
      record(s, turnId, tier, "nothing_built", uncheckedChecks("no files changed in this turn."));
      return { continued: false };
    }

    const tokensFile = path.join(s.cwd, "design", "tokens.css");
    const hasDesign = fs.existsSync(path.join(s.cwd, "DESIGN.md")) || fs.existsSync(tokensFile);
    const uiChanged = built.files.some(isUi);
    const checks: Check[] = [
      !hasDesign
        ? skipped("design", "no DESIGN.md or design/tokens.css in this workspace.")
        : !uiChanged
          ? skipped("design", "no UI files changed.")
          : { id: "design", skip: null, violations: designViolations(built, readOr(tokensFile)) },
      tier === "tweak" ? skipped("spec", "a tweak needs no spec.") : checkOf("spec", specViolation(tier, built.files, listAttached(s.id).length)),
      tier === "tweak" ? skipped("roadmap", "a tweak needs no roadmap item.") : checkOf("roadmap", roadmapViolation(tier, built.files, roadmapFileOf(s))),
      tier === "tweak" ? skipped("docs", "a tweak needs no doc.") : !built.files.some(isSource) ? skipped("docs", "no source files changed.") : checkOf("docs", docsViolation(tier, built.files, docsDirForSession(s))),
    ];
    // The enabled practice packs, on the same files (paths relative to the session's directory, as the diff gives them).
    // Their findings join this fix turn only in fix mode; in warn they are reported in the log, and nothing is sent.
    const practice = practiceRun(s.cwd, built.files, s.base_cwd);
    if (practice.enforce === "warn" && practice.findings.length) {
      note(s, turnId, `${practice.findings.length} practice finding${practice.findings.length === 1 ? "" : "s"}, reported only (practices are on warn): ${practice.findings.slice(0, 3).map(practiceLine).join("; ")}`);
    }
    const violations = [...checks.flatMap((c) => c.violations), ...(practice.enforce === "fix" ? practice.findings.map(practiceLine) : [])];
    const results = checks.map(checkResult);

    if (!violations.length) {
      resetAttempts(sessionId);
      record(s, turnId, tier, "passed", results);
      return { continued: false };
    }
    if (getState(sessionId).attempts >= MAX_FIX_ATTEMPTS) {
      note(s, turnId, `gate gave up after ${MAX_FIX_ATTEMPTS} attempts. Not met: ${violations.slice(0, 3).join("; ")}`);
      record(s, turnId, tier, "gave_up", results);
      return { continued: false };
    }
    const attempt = bumpAttempts(sessionId);
    note(s, turnId, `${violations.length} rule${violations.length === 1 ? "" : "s"} not met (${tier}). Sending them back to the agent (fix ${attempt} of ${MAX_FIX_ATTEMPTS}).`);
    // Recorded before the fix turn starts, so the fix turn and the UI both see that the gate is fixing.
    record(s, turnId, tier, "fixing", results);
    try {
      send({ operator: true }, sessionId, fixPrompt(violations, attempt));
      return { continued: true };
    } catch (err: any) {
      note(s, turnId, `could not start the fix turn: ${err?.message ?? err}`);
      record(s, turnId, tier, "gave_up", results);
      return { continued: false };
    }
  } catch (err: any) {
    console.warn(`[trb] treeboss ${sessionId}: ${err?.message ?? err}`);
    return { continued: false };
  }
}
