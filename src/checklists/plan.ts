/**
 * A checklist pass, as Lab sees it: which items a session takes, how they are split into sessions, and the prompt the
 * session starts with. The items' state comes from the checklist's file (files.ts); the stack block from stack-context.ts.
 *
 * A pass is a sweep over chunks. A chunk is a token, `checklist:<checklistId>:<itemId>,<itemId>…`, of at most CHUNK_ITEMS
 * items; the sweep runner (lab/sweeps.ts) stores the tokens, so a restart carries on with the same items.
 *
 *   audit  every item that is not passing and not decided by hand (a manual item is a person's)
 *   fix    the failing and unknown items: the session changes the code until each one passes
 */
import type { Checklist, ChecklistItem } from "./catalog";
import { UNANSWERED, type ItemAnswer } from "./files";
import { checklistById } from "./custom";
import { projectChecklist } from "./project";
import { stackContext } from "../lab/stack-context";
import { owningWorkspace, Workspaces } from "../workspaces";
import { readJudgements } from "./screens";
import { checkUrls, SALES_PAGE_ITEMS } from "./urls";

/** About this many items per session: enough to amortise the stack read, few enough that each answer gets real attention. */
export const CHUNK_ITEMS = 10;

const TOKEN = /^checklist:([a-z0-9][a-z0-9-]*):([A-Za-z0-9._,-]+)$/;

/** The answers a checklist's file holds, by item id. Empty when the checklist is not attached. */
export function answersOf(rootDir: string, checklistId: string): Map<string, ItemAnswer> {
  return projectChecklist(rootDir, checklistId)?.file.answers ?? new Map();
}

/** The items a pass takes. */
export function openItems(c: Checklist, answers: Map<string, ItemAnswer>, fix: boolean): ChecklistItem[] {
  return c.items.filter((item) => {
    if (item.kind === "manual") return false;
    const a = answers.get(item.id) ?? UNANSWERED;
    if (a.source === "manual") return false;
    return fix ? a.status === "fail" || a.status === "unknown" : a.status !== "pass";
  });
}

/** The chunks of a checklist's open items: by category, packed into sessions of at most CHUNK_ITEMS, a category split only when it is bigger. */
export function chunkTokens(c: Checklist, items: ChecklistItem[]): string[] {
  const groups: ChecklistItem[][] = [];
  let cur: ChecklistItem[] = [];
  for (const category of [...new Set(c.items.map((i) => i.category))]) {
    const inCat = items.filter((i) => i.category === category);
    for (let i = 0; i < inCat.length; i += CHUNK_ITEMS) {
      const part = inCat.slice(i, i + CHUNK_ITEMS);
      if (cur.length && cur.length + part.length > CHUNK_ITEMS) {
        groups.push(cur);
        cur = [];
      }
      cur.push(...part);
    }
  }
  if (cur.length) groups.push(cur);
  return groups.map((g) => `checklist:${c.id}:${g.map((i) => i.id).join(",")}`);
}

/** The chunks for a pass over the given checklists (all attached ones when `checklistIds` is null). */
export function passChunks(rootDir: string, checklistIds: string[], fix: boolean): string[] {
  return checklistIds.flatMap((id) => {
    const p = projectChecklist(rootDir, id);
    return p ? chunkTokens(p.checklist, openItems(p.checklist, p.file.answers, fix)) : [];
  });
}

/**
 * Reads a chunk token back: the checklist and its items, refused when the token is not one this module wrote. With `rootDir`
 * the checklist is the project's (its own items included, and the checklist must be attached there); without it, the catalog's.
 */
export function parseToken(token: string, rootDir?: string): { checklist: Checklist; items: ChecklistItem[] } {
  const m = TOKEN.exec(token);
  const c = !m ? null : rootDir ? (projectChecklist(rootDir, m[1]!)?.checklist ?? null) : checklistById(m[1]!);
  if (!m || !c) throw new Error(`"${token}" is not a checklist chunk.`);
  const items = m[2]!.split(",").map((id) => c.items.find((i) => i.id === id));
  if (items.some((i) => !i)) throw new Error(`"${token}" names an item ${c.id} does not have.`);
  return { checklist: c, items: items as ChecklistItem[] };
}

export interface ChecklistPass {
  title: string;
  /** What the session is told: the stack, the items and how to record them. */
  prompt: string;
  /** What the operator sees in the session list, before the prompt. */
  visible: string;
  checklistId: string;
  itemIds: string[];
}

/** The prompt of one chunk. The items' current state is read now, so a retried chunk says what it says at the time it starts. */
export function checklistPass(rootDir: string, token: string, opts: { fix?: boolean; note?: string | null } = {}): ChecklistPass {
  // The project's view when the checklist is attached there; otherwise the catalog's (launch refuses an unattached one).
  const parsed = (() => {
    try {
      return parseToken(token, rootDir);
    } catch {
      return parseToken(token);
    }
  })();
  const { checklist: c, items } = parsed;
  const fix = !!opts.fix;
  const answers = answersOf(rootDir, c.id);
  const judgements = readJudgements(rootDir, c.id);
  const line = (i: ChecklistItem) => {
    const a = answers.get(i.id) ?? UNANSWERED;
    const now = [`now ${a.status}`, a.source ? `(${a.source})` : "", a.evidence ? `last evidence ${a.evidence}` : "", a.reason ? `reason: ${a.reason}` : "", a.note ? `operator's note: ${a.note}` : ""].filter(Boolean).join(", ");
    const j = judgements.get(i.id);
    const shot = j ? `\n  Screenshot judgement (probe, ${j.at}): ${j.observed}, ${j.reason}. Look at ${j.shots.map((s) => s.image).join(", ")}.` : "";
    return `- ${i.text} (${i.id}) [${i.severity}], ${now}\n  ${fix ? "How to fix" : "How to check"}: ${i.hint}${shot}`;
  };
  // Manual items are a person's: the agent is told they exist, so it can say what it sees, and never records them.
  const left = c.items.filter((i) => i.kind === "manual" && (answers.get(i.id) ?? UNANSWERED).status !== "pass");
  // Judging a sales page needs it served: a fix session is told where, so it does not guess a port.
  const wsId = fix && items.some((i) => SALES_PAGE_ITEMS.has(i.id)) ? owningWorkspace(rootDir) : null;
  const served = wsId ? checkUrls(wsId, Workspaces.get(wsId)?.path ?? rootDir) : [];
  const prompt = [
    `Lab pass: checklist ${fix ? "fix" : "audit"}. Verify these ${items.length} items of "${c.title}" in this project, one by one, against the code.`,
    "",
    stackContext(rootDir),
    "",
    "Items:",
    ...items.map(line),
    "",
    ...(served.length ? ["Served URLs, to judge the sales-page items against (hints name the page files):", ...served.map((u) => `- ${u.label}: ${u.url}`), ""] : []),
    ...(left.length ? ["Left for a person (do not record them, and do not decide them). Say in your reply what you see on each:", ...left.map((i) => `- ${i.text} (${i.id})`), ""] : []),
    fix
      ? "Change the code until each item passes. Keep each change small, run the project's own checks (typecheck, tests, build) after changing code, and say what you changed. Record each item once it is done or once it has failed."
      : "Read the code and templates; do not change any file. Record the result of every item.",
    "",
    `How to record: call checklist_record once for every item above. Give checklist "${c.id}", item (the id in brackets), status (pass, fail or na), evidence (the file and line you read, such as app/page.tsx:12, or a URL you measured) and note (what you saw, in a sentence).`,
    "- Use na only when the item does not apply to this project, and give the reason in note.",
    "- Never guess. If you cannot verify an item from the code, record fail and say in note what is missing.",
    "- A failing item becomes a Lab finding by itself: do not write findings files.",
    "- Do not tick items by hand and do not record manual items.",
    "- Never write a secret into the repository. Use the secrets store or environment variables.",
    opts.note?.trim() ? `\nThe operator asks you to focus on: ${opts.note.trim()}` : "",
    "When every item is recorded, reply with the count per status and the items you could not verify.",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
  return {
    title: `Checklist ${fix ? "fix" : "audit"}: ${c.title}`,
    prompt,
    visible: `Checklist ${fix ? "fix" : "audit"} of ${c.title}: ${items.length} items (${items.map((i) => i.id).join(", ")}).`,
    checklistId: c.id,
    itemIds: items.map((i) => i.id),
  };
}
