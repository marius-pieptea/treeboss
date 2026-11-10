/**
 * Failing checklist items as Lab findings: one finding per item, `checklist: <checklistId>/<itemId>`, lens `checklist`.
 *
 *  - a fail opens the finding, or refreshes its evidence and body when the evidence moved (a shipped one is reopened);
 *  - a pass ships it (status shipped), unless the operator dismissed it;
 *  - dismissing the finding in Lab marks the item n/a with the note "dismissed in Lab", pinned as a manual answer, so the
 *    checks leave it alone; reopening the finding puts the item back to unknown for the checks to decide. A required item
 *    cannot be dismissed: it blocks a prod deploy until it passes or an agent records why it does not apply.
 */
import { UserError } from "../util";
import { evidencePath, listFindings, patchFinding, shipChecklistFindings, STATUSES, writeFinding, type Finding, type Impact, type Status } from "../lab/findings";
import type { Checklist, ChecklistItem, Severity } from "./catalog";
import { patchChecklistFile, readChecklistFile, UNANSWERED, type ItemAnswer } from "./files";
import { projectChecklist } from "./project";

export const DISMISSED_NOTE = "dismissed in Lab";
const KEY = (checklistId: string, itemId: string) => `${checklistId}/${itemId}`;
/** The finding's file name: one per item, so a repeat fail finds the same file. */
export const findingIdOf = (checklistId: string, itemId: string): string => `checklist-${checklistId}-${itemId}`.toLowerCase();

/** The impact a failing item carries: a required item blocks a launch, so it is high. */
export const impactOf = (severity: Severity): Impact => (severity === "required" ? "high" : "medium");

/** The checklist findings of a project, keyed by `<checklistId>/<itemId>`. */
export function findingsByItem(rootDir: string): Map<string, Finding> {
  const out = new Map<string, Finding>();
  for (const f of listFindings(rootDir)) if (f.checklist) out.set(f.checklist, f);
  return out;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * After an item's answer is written: a fail opens or refreshes its finding, a pass ships it. Any other answer leaves the
 * finding alone. Returns the finding's id, or null when there is none.
 */
export function syncItemFinding(rootDir: string, c: Checklist, item: ChecklistItem, answer: ItemAnswer, message: string | null = null): string | null {
  const key = KEY(c.id, item.id);
  const existing = findingsByItem(rootDir).get(key) ?? null;
  if (answer.status === "pass") {
    if (existing && existing.status !== "dismissed" && existing.status !== "shipped") patchFinding(rootDir, existing.id, { status: "shipped" });
    return existing?.id ?? null;
  }
  if (answer.status !== "fail") return existing?.id ?? null;

  const evidence = answer.evidence ? [answer.evidence] : [];
  const id = existing?.id ?? findingIdOf(c.id, item.id);
  if (existing?.status === "dismissed") return existing.id;
  const status: Status = existing?.status === "shipped" || !existing ? "new" : existing.status;
  if (existing && existing.status === status && sameList(existing.evidence, evidence)) return existing.id;
  const why = [`Checklist item ${key} (${item.severity}) does not pass.`, message ? `The check said: ${message}` : "", answer.reason ? `Reason: ${answer.reason}` : "", answer.note ? `Note: ${answer.note}` : ""].filter(Boolean).join(" ");
  writeFinding(
    rootDir,
    id,
    {
      title: item.text,
      lens: "checklist",
      scope: evidencePath(answer.evidence ?? "") ?? "project",
      impact: impactOf(item.severity),
      effort: existing?.effort ?? "s",
      status,
      evidence,
      checklist: key,
      roadmap: existing?.roadmap ?? null,
      spec: existing?.spec ?? null,
    },
    `${why}\n\nFirst step: ${item.hint}`,
  );
  return id;
}

/** Ships an item's open finding, for an item that no longer fails or no longer exists. A shipped or dismissed finding is left as it is. */
export function closeItemFinding(rootDir: string, checklistId: string, itemId: string): void {
  shipChecklistFindings(rootDir, checklistId, (id) => id !== itemId);
}

/** The checklist and item a finding is about, when it is a checklist finding that still names an item of an attached checklist. */
function itemOfFinding(rootDir: string, f: Finding): { checklist: Checklist; item: ChecklistItem } | null {
  if (!f.checklist) return null;
  const [cid, iid] = f.checklist.split("/");
  const c = cid ? projectChecklist(rootDir, cid)?.checklist : null;
  const item = c?.items.find((i) => i.id === iid);
  return c && item ? { checklist: c, item } : null;
}

/**
 * Changes a finding's status (or impact and effort) from Lab. A dismissal of a checklist finding marks its item n/a; reopening
 * it clears that mark. Refused for a required item, before anything changes.
 */
export function patchLabFinding(rootDir: string, id: string, patch: { status?: Status; impact?: Impact; effort?: Finding["effort"]; confirmed?: boolean }): Finding {
  const f = listFindings(rootDir).find((x) => x.id === id);
  if (f && patch.status !== undefined && (STATUSES as readonly string[]).includes(patch.status)) {
    const linked = itemOfFinding(rootDir, f);
    if (linked && patch.status === "dismissed" && f.status !== "dismissed") dismissItem(rootDir, linked.checklist, linked.item);
    if (linked && f.status === "dismissed" && patch.status !== "dismissed") reopenItem(rootDir, linked.checklist, linked.item);
  }
  return patchFinding(rootDir, id, patch);
}

function dismissItem(rootDir: string, c: Checklist, item: ChecklistItem): void {
  if (item.severity === "required") {
    throw new UserError(`${item.id} is a required launch item, so it cannot be dismissed: it blocks a prod deploy until it passes. Fix it, or have the audit record why it does not apply.`);
  }
  const file = readChecklistFile(rootDir, c.id);
  if (!file) return; // the checklist is not attached: nothing to mark
  const cur = file.answers.get(item.id) ?? UNANSWERED;
  patchChecklistFile(rootDir, c, new Map([[item.id, { status: "na", source: "manual", evidence: cur.evidence, message: null, reason: null, note: DISMISSED_NOTE }]]), new Date().toISOString());
}

function reopenItem(rootDir: string, c: Checklist, item: ChecklistItem): void {
  const cur = readChecklistFile(rootDir, c.id)?.answers.get(item.id);
  if (!cur || cur.source !== "manual" || cur.status !== "na" || cur.note !== DISMISSED_NOTE) return;
  patchChecklistFile(rootDir, c, new Map([[item.id, UNANSWERED]]), new Date().toISOString());
}
