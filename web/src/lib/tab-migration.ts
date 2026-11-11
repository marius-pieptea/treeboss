/**
 * Saved tabs from an earlier version of the UI state, brought up to date when the store restores them. Pure, so the
 * rules are tested without the store.
 */

/** Factory pages that were removed, and the page a saved tab on one lands on. Checklists moved into the Lab. */
const MOVED_FACTORY_PAGES = new Map<string, string>([["checklists", "portfolio"]]);

/** The one Lab tab was split into Findings and Checklists (and Bugs, since folded into QA): a saved Lab tab opens as Findings, as the Lab did. */
const FINDINGS = { id: "findings", kind: "findings", title: "Findings" };

/** The Bugs view became part of QA: a saved Bugs tab opens as the QA tab. */
const QA = { id: "qa", kind: "qa", title: "QA" };

type SavedTab = { id?: unknown; kind?: unknown; page?: unknown };

/** Only a factory tab's `page` is remapped: a settings tab has a page of its own (`checklists` is one of them). */
export function migrateSavedTabs<T extends SavedTab>(tabs: T[]): T[] {
  const out: T[] = [];
  for (const t of tabs) {
    if (t.kind === "lab") {
      if (!out.some((x) => x.id === FINDINGS.id)) out.push({ ...t, ...FINDINGS });
      continue;
    }
    if (t.kind === "bugs" || t.kind === "qa") {
      if (!out.some((x) => x.id === QA.id)) out.push({ ...t, ...QA });
      continue;
    }
    if (t.kind !== "factory" || typeof t.page !== "string") {
      out.push(t);
      continue;
    }
    const moved = MOVED_FACTORY_PAGES.get(t.page);
    out.push(moved ? { ...t, page: moved } : t);
  }
  return out;
}

const renameTab = (id: unknown) => (id === "lab" ? FINDINGS.id : id === "bugs" ? QA.id : id);

/** A workspace's saved state: its tabs, and the active tab and history that name them by id. */
export function migrateSavedWs<W extends { tabs?: SavedTab[]; activeTab?: unknown; history?: unknown }>(ws: W): W {
  if (!ws.tabs) return ws;
  const history = Array.isArray(ws.history) ? [...new Set(ws.history.map(renameTab))] : ws.history;
  return { ...ws, tabs: migrateSavedTabs(ws.tabs), activeTab: renameTab(ws.activeTab), history };
}
