/**
 * Unsent text (the agent composer, the commit message), kept per workspace and session or per git root so it survives
 * switching sessions or workspaces, a panel unmounting (the Heads tab) and a reload. No React here, so it is
 * unit-tested directly (tests-trace/web/drafts.test.ts).
 *
 * One localStorage value holds every draft. Writes are coalesced: typing updates the in-memory map at once and the
 * value is written after a short pause, and on the way out of the page.
 */

export type Drafts = Record<string, { text: string; at: number }>;

type Store = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "trb.agent.drafts";
/** How many drafts are kept: the oldest go first, so abandoned sessions do not grow the value forever. */
export const MAX_DRAFTS = 50;
const WRITE_DELAY_MS = 300;

/** The commit message of a git root (`w_…` workspace or `s_…` session worktree). */
export const commitDraftKey = (root: string): string => `commit:${root}`;

/** The empty session of a workspace has no id yet: it is that workspace's one "new" draft. */
export const draftKey = (wsId: string | null, sid: string | null): string => `${wsId ?? "-"}:${sid ?? "new"}`;

/** The map with this draft set (a blank text removes it), trimmed to the newest MAX_DRAFTS. Pure: returns a new map. */
export function withDraft(drafts: Drafts, key: string, text: string, now: number, max = MAX_DRAFTS): Drafts {
  const { [key]: _old, ...rest } = drafts;
  if (!text.trim()) return rest;
  const next: Drafts = { ...rest, [key]: { text, at: now } };
  const keys = Object.keys(next);
  if (keys.length <= max) return next;
  const keep = keys.sort((a, b) => next[b].at - next[a].at).slice(0, max);
  return Object.fromEntries(keep.map((k) => [k, next[k]]));
}

/** Drop every draft of one session (it was deleted), in any workspace. */
export function withoutSession(drafts: Drafts, sid: string): Drafts {
  return Object.fromEntries(Object.entries(drafts).filter(([k]) => !k.endsWith(`:${sid}`)));
}

/** Whatever was stored, reduced to well-formed entries: a corrupt or foreign value reads as no drafts. */
export function parseDrafts(raw: string | null | undefined): Drafts {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Drafts = {};
    for (const [k, e] of Object.entries(v)) {
      const d = e as { text?: unknown; at?: unknown };
      if (typeof d?.text === "string" && d.text.trim() && typeof d.at === "number") out[k] = { text: d.text, at: d.at };
    }
    return out;
  } catch {
    return {};
  }
}

function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export interface DraftStore {
  get(key: string): string;
  set(key: string, text: string): void;
  /** Forget a session's drafts everywhere (it was deleted). */
  dropSession(sid: string): void;
  flush(): void;
}

export function createDraftStore(store: Store | null = defaultStore(), now: () => number = Date.now): DraftStore {
  let drafts: Drafts | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const load = (): Drafts => (drafts ??= parseDrafts(safeRead(store)));
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!drafts) return;
    try {
      store?.setItem(STORAGE_KEY, JSON.stringify(drafts));
    } catch {}
  };
  const schedule = () => {
    timer ??= setTimeout(flush, WRITE_DELAY_MS);
  };
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  }
  return {
    get: (key) => load()[key]?.text ?? "",
    set: (key, text) => {
      const cur = load();
      if (!text.trim() && !cur[key]) return;
      if ((cur[key]?.text ?? "") === text) return;
      drafts = withDraft(cur, key, text, now());
      schedule();
    },
    dropSession: (sid) => {
      drafts = withoutSession(load(), sid);
      schedule();
    },
    flush,
  };
}

function safeRead(store: Store | null): string | null {
  try {
    return store?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The page's one store. */
export const drafts = createDraftStore();
