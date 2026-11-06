/**
 * Treeboss mode: the agent works opinionated (triage, design and docs checks, specs on the roadmap). The daemon enforces
 * it after each turn; these are the composer's rules for showing it and for what a new session starts with.
 */
import type { CheckId, CheckStatus, Setting, SessionView, Tier, TreebossViewState } from "@/lib/types";

/** The composer toggle's tooltip: what the mode changes, in one line. */
export const TREEBOSS_TIP = "Treeboss mode: tier triage, design and docs checks, specs on the roadmap.";

/** Whether new sessions start in treeboss mode: the `treeboss_mode` setting. Off until the settings have loaded. */
export function treebossDefault(settings: Pick<Setting, "key" | "value">[] | undefined): boolean {
  return settings?.find((s) => s.key === "treeboss_mode")?.value === "on";
}

/** Whether an open session is in treeboss mode. A session from before the field existed is not. */
export const sessionTreeboss = (s: Pick<SessionView, "treeboss"> | null | undefined): boolean => s?.treeboss === true;

/** The gates in the order the gate checks them. */
export const GATE_IDS: CheckId[] = ["design", "spec", "roadmap", "docs"];
export const GATE_LABELS: Record<CheckId, string> = { design: "Design", spec: "Spec", roadmap: "Roadmap", docs: "Docs" };

/** idle: nothing to show yet. fixing: the agent is retrying. passed and gave_up are the end states. */
export type GateTone = "idle" | "fixing" | "passed" | "gave_up";

export interface GateProgress {
  passed: number;
  /** Gates that ran: every check that is not a skip. */
  applicable: number;
  /** passed / applicable, 0 to 1. With nothing applicable it is 1 only when the last turn passed. */
  fraction: number;
  tone: GateTone;
}

const TONE: Record<string, GateTone> = { passed: "passed", fixing: "fixing", gave_up: "gave_up", nothing_built: "idle", not_checked: "idle" };

/** How far the last turn got through its gates: the pill's fill, and the card's header count. */
export function gateProgress(state: TreebossViewState | null | undefined): GateProgress {
  const last = state?.last_check ?? null;
  if (!last) return { passed: 0, applicable: 0, fraction: 0, tone: "idle" };
  const applicable = last.checks.filter((c) => c.status !== "skip").length;
  const passed = last.checks.filter((c) => c.status === "pass").length;
  const fraction = applicable > 0 ? passed / applicable : last.outcome === "passed" ? 1 : 0;
  return { passed, applicable, fraction, tone: TONE[last.outcome] ?? "idle" };
}

export interface GateRow {
  id: CheckId;
  label: string;
  /** pending: the last turn has no result for this gate. */
  status: CheckStatus | "pending";
  /** The violation on a fail, the reason on a skip, "not checked yet" when pending. */
  detail: string | null;
}

/** The four gates in order, each with the last turn's result (or pending when there is none). */
export function gateRows(state: TreebossViewState | null | undefined): GateRow[] {
  const checks = state?.last_check?.checks ?? [];
  return GATE_IDS.map((id) => {
    const c = checks.find((x) => x.id === id);
    if (!c) return { id, label: GATE_LABELS[id], status: "pending", detail: "not checked yet" };
    return { id, label: GATE_LABELS[id], status: c.status, detail: c.detail };
  });
}

/** The tier and who set it: "feature (set by you)", "tweak (agent)", or "no tier yet". */
export function tierLabel(state: TreebossViewState | null | undefined): string {
  if (!state?.tier) return "no tier yet";
  if (state.tier_source === "operator") return `${state.tier} (set by you)`;
  if (state.tier_source === "agent") return `${state.tier} (agent)`;
  return state.tier;
}

/** The card's footer: what the last turn's gate run came to. */
export function gateFooter(state: TreebossViewState | null | undefined): string {
  const outcome = state?.last_check?.outcome;
  switch (outcome) {
    case "passed":
      return "All gates passed on the last turn";
    case "fixing":
      return `Fixing: attempt ${state!.attempts} of ${state!.max_attempts}`;
    case "gave_up":
      return `Gave up after ${state!.max_attempts} attempts`;
    case "nothing_built":
      return "Last turn built nothing to check";
    default:
      return "Gates run after the next turn that changes files";
  }
}

/** The tier line the agent writes first in treeboss mode, as the gate reads it: bold, backticks and a line in the middle count too. */
const TIER_LINE = /^[ \t`*]*TREEBOSS_TIER:[ \t`*]*(tweak|feature|area)\b[^\n]*$/i;
/** A code fence opener: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Takes the tier lines out of an assistant message for display. The last one wins. Lines inside a fenced code block stay,
 * and text with no tier line comes back unchanged. The stored text is not touched: the gate reads it as it is.
 */
export function extractTierLines(text: string): { text: string; tier: Tier | null } {
  const kept: string[] = [];
  let tier: Tier | null = null;
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line);
    if (fence) {
      // A closing fence is the same character, at least as long, with nothing else on the line.
      if (f && !f[2].trim() && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      kept.push(line);
      continue;
    }
    if (f) {
      fence = f[1];
      kept.push(line);
      continue;
    }
    const m = TIER_LINE.exec(line);
    if (m) {
      tier = m[1].toLowerCase() as Tier;
      continue;
    }
    kept.push(line);
  }
  if (!tier) return { text, tier: null };
  return { text: kept.join("\n").replace(/^\n+|\n+$/g, ""), tier };
}
