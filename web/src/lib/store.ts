/**
 * UI state: layout, theme, and per-workspace tabs. Server state lives in react-query, not here.
 *
 * Tabs are per workspace and persisted, so reopening a project brings back what was open. Ids are derived
 * from what a tab shows (`file:w_1:src/a.ts`), so opening the same thing twice focuses it instead of
 * duplicating it.
 */
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { applyGlass, readGlassPref, storeGlassPref } from "./glass";
import { applyTheme, readStoredPref, resolveTheme, systemPrefersDark, type Mode, type Palette, type ThemePref } from "./theme";
import { migrateSavedWs } from "./tab-migration";

export type Activity = "sessions" | "explorer" | "search" | "git" | "specs" | "docs" | "settings";
export type RightTab = "agent" | "heads";
export type BottomTab = "terminal" | "output";
export type FactoryPage = "portfolio" | "autopilot" | "ship" | "releases" | "practices" | "mobile" | "signals" | "secrets";
export type SettingsPage = "agents"| "pairs" | "mcp" | "skills" | "engines" | "config" | "workspace" | "remote" | "verify" | "practices" | "templates" | "design-systems" | "checklists" | "about";

export type Tab =
  | { id: string; kind: "file"; root: string; path: string; title: string; preview?: boolean; line?: number }
  | { id: string; kind: "diff"; root: string; path: string; title: string; staged?: boolean; untracked?: boolean; commit?: string; base?: string; head?: string; preview?: boolean }
  | { id: string; kind: "commit"; root: string; sha: string; title: string }
  | { id: string; kind: "browser"; url: string; title: string }
  | { id: string; kind: "settings"; page: SettingsPage; title: string }
  | { id: string; kind: "session"; sessionId: string; title: string }
  | { id: string; kind: "spec"; root: string; feature: string; title: string; doc?: string }
  | { id: string; kind: "doc"; root: string; path: string; title: string }
  | { id: string; kind: "plan"; root: string; sessionId: string; planId: string; path: string | null; title: string }
  | { id: string; kind: "roadmap"; title: string }
  | { id: string; kind: "design"; title: string }
  | { id: string; kind: "findings"; title: string }
  | { id: string; kind: "bugs"; title: string }
  | { id: string; kind: "checklists"; title: string }
  | { id: string; kind: "qa"; title: string }
  | { id: string; kind: "emulator"; title: string }
  | { id: string; kind: "memory"; title: string }
  | { id: string; kind: "evidence"; title: string }
  | { id: string; kind: "factory"; page: FactoryPage; title: string }
  | { id: string; kind: "transcripts"; title: string };

export type NewTab = Tab extends infer T ? (T extends { id: string } ? Omit<T, "id"> & { id?: string } : never) : never;

export function tabId(t: NewTab): string {
  switch (t.kind) {
    case "file":
      return `file:${t.root}:${t.path}`;
    case "diff":
      return `diff:${t.root}:${t.path}:${t.commit ?? t.base ?? (t.staged ? "staged" : t.untracked ? "new" : "work")}`;
    case "commit":
      return `commit:${t.root}:${t.sha}`;
    case "browser":
      return `browser:${t.url}`;
    case "settings":
      // One settings tab: the modules switch its page in place rather than opening a tab each.
      return "settings";
    case "session":
      return `session:${t.sessionId}`;
    case "doc":
      return `doc:${t.root}:${t.path}`;
    case "spec":
      return `spec:${t.root}:${t.feature}`;
    case "plan":
      return `plan:${t.sessionId}:${t.path ?? t.planId}`;
    case "roadmap":
      return "roadmap";
    case "design":
      return "design";
    case "findings":
    case "bugs":
    case "checklists":
    case "qa":
    case "emulator":
      return t.kind;
    case "memory":
      return "memory";
    case "evidence":
      return "evidence";
    case "factory":
      // One factory tab: its sub-pages switch in place, as the settings page does.
      return "factory";
    case "transcripts":
      return "transcripts";
  }
}

export interface WsState {
  tabs: Tab[];
  activeTab: string | null;
  activeSession: string | null;
  /** Expanded directories in the explorer. */
  expanded: string[];
  /** Most recently active tabs first, for Ctrl-Tab style switching and for picking a neighbour on close. */
  history: string[];
}

export const emptyWs = (): WsState => ({ tabs: [], activeTab: null, activeSession: null, expanded: [], history: [] });

/** Opens a tab in one workspace's state: focuses it if it is open already, otherwise adds it. Used by openTab, and by a switch that opens the factory in another workspace. */
export function withTabOpened(ws: WsState, tab: NewTab): WsState {
  const id = tab.id ?? tabId(tab);
  const existing = ws.tabs.find((t) => t.id === id);
  let tabs = ws.tabs;
  if (existing) {
    // Opening the same thing for real (not as a preview) pins a preview tab.
    if ("preview" in existing && existing.preview && !(tab as any).preview) tabs = tabs.map((t) => (t.id === id ? ({ ...t, preview: false } as Tab) : t));
    if ((tab as any).line !== undefined && existing.kind === "file") tabs = tabs.map((t) => (t.id === id ? ({ ...t, line: (tab as any).line } as Tab) : t));
    if (existing.kind === "settings" && tab.kind === "settings") tabs = tabs.map((t) => (t.id === id ? ({ ...t, page: tab.page, title: tab.title } as Tab) : t));
    if (existing.kind === "factory" && tab.kind === "factory") tabs = tabs.map((t) => (t.id === id ? ({ ...t, page: tab.page, title: tab.title } as Tab) : t));
  } else {
    // A new preview replaces the previous preview, so browsing files does not fill the strip.
    if ((tab as any).preview) tabs = tabs.filter((t) => !("preview" in t && t.preview));
    tabs = [...tabs, { ...tab, id } as Tab].slice(-MAX_TABS);
  }
  return { ...ws, tabs, activeTab: id, history: [id, ...ws.history.filter((h) => h !== id)].slice(0, 60) };
}

interface UiState {
  /** What the user picked (may follow the OS), the palette it resolves to, and the resolved light/dark mode. */
  themePref: ThemePref;
  palette: Palette;
  theme: Mode;
  /** Translucent chrome over the OS material (desktop app only; a no-op elsewhere). Owned by localStorage "trb.glass". */
  glass: boolean;
  activity: Activity;
  leftOpen: boolean;
  rightOpen: boolean;
  rightTab: RightTab;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  /** Pane sizes in px. */
  leftW: number;
  rightW: number;
  bottomH: number;
  /** Widths of resizable panes inside pages, by key (e.g. "evidence.list"). */
  panes: Record<string, number>;
  /** Current workspace id, and each workspace's own state. */
  current: string | null;
  byWs: Record<string, WsState>;
  /** Tabs with unsaved edits. Not persisted: a reload loses the buffer anyway. */
  dirty: Record<string, boolean>;

  setTheme(t: ThemePref): void;
  setGlass(on: boolean): void;
  setActivity(a: Activity): void;
  toggleLeft(): void;
  toggleRight(): void;
  toggleBottom(): void;
  setRightTab(t: RightTab): void;
  setBottomTab(t: BottomTab): void;
  setCurrent(id: string | null): void;
  setPane(key: string, px: number): void;
  setSize(which: "leftW" | "rightW" | "bottomH", px: number): void;

  openTab(tab: NewTab): string;
  closeTab(id: string): void;
  closeOthers(id: string): void;
  closeAll(): void;
  activateTab(id: string): void;
  pinTab(id: string): void;
  updateTab(id: string, patch: Partial<Tab>): void;
  setDirty(id: string, dirty: boolean): void;
  setActiveSession(id: string | null): void;
  /** Set the session a workspace opens on, without switching to it (a pinned lead from elsewhere). */
  setActiveSessionIn(ws: string, id: string): void;
  toggleExpanded(path: string, open?: boolean): void;
}

const MAX_TABS = 40;

/** localStorage writes are synchronous and the whole workspace map is one value: coalesce them so a splitter drag or a burst of tab changes writes once. */
const lazyStorage: StateStorage = (() => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: [string, string] | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const [k, v] = pending;
    pending = null;
    try {
      localStorage.setItem(k, v);
    } catch {}
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  }
  return {
    getItem: (k) => (pending && pending[0] === k ? pending[1] : localStorage.getItem(k)),
    setItem: (k, v) => {
      pending = [k, v];
      timer ??= setTimeout(flush, 400);
    },
    removeItem: (k) => localStorage.removeItem(k),
  };
})();

export const useUi = create<UiState>()(
  persist(
    (set, get) => {
      const mutateWs = (fn: (ws: WsState) => WsState) =>
        set((s) => {
          if (!s.current) return s;
          return { byWs: { ...s.byWs, [s.current]: fn(s.byWs[s.current] ?? emptyWs()) } };
        });

      return {
        // theme.js already applied the stored/system choice before paint; start from what the page shows.
        themePref: readStoredPref(),
        palette: typeof document === "undefined" ? "default" : document.documentElement.dataset.theme === "catppuccin" ? "catppuccin" : document.documentElement.dataset.theme === "spritecraft" ? "spritecraft" : "default",
        theme: typeof document !== "undefined" && !document.documentElement.classList.contains("dark") ? "light" : "dark",
        glass: readGlassPref(),
        activity: "sessions",
        leftOpen: true,
        rightOpen: true,
        rightTab: "agent",
        bottomOpen: false,
        bottomTab: "terminal",
        leftW: 280,
        rightW: 440,
        panes: {},
        bottomH: 280,
        current: null,
        byWs: {},
        dirty: {},

        setTheme: (pref) => {
          const { palette, mode } = resolveTheme(pref, systemPrefersDark());
          applyTheme(palette, mode);
          try {
            localStorage.setItem("trb.theme", pref);
          } catch {}
          set({ themePref: pref, palette, theme: mode });
        },
        setGlass: (on) => {
          applyGlass(on);
          storeGlassPref(on);
          set({ glass: on });
        },
        setActivity: (a) => {
          const s = get();
          // Clicking the active activity collapses the sidebar, like every editor.
          if (s.activity === a && s.leftOpen) set({ leftOpen: false });
          else set({ activity: a, leftOpen: true });
        },
        toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
        toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
        toggleBottom: () => set((s) => ({ bottomOpen: !s.bottomOpen })),
        setRightTab: (rightTab) => set({ rightTab, rightOpen: true }),
        setBottomTab: (bottomTab) => set({ bottomTab, bottomOpen: true }),
        setPane: (key, px) => set((s) => ({ panes: { ...s.panes, [key]: Math.round(px) } })),
        setSize: (which, px) => set({ [which]: Math.round(px) } as any),
        setCurrent: (current) => set((s) => ({ current, byWs: current && !s.byWs[current] ? { ...s.byWs, [current]: emptyWs() } : s.byWs })),

        openTab: (tab) => {
          mutateWs((ws) => withTabOpened(ws, tab));
          return tab.id ?? tabId(tab);
        },
        closeTab: (id) => {
          mutateWs((ws) => {
            const idx = ws.tabs.findIndex((t) => t.id === id);
            if (idx === -1) return ws;
            const tabs = ws.tabs.filter((t) => t.id !== id);
            const history = ws.history.filter((h) => h !== id);
            let activeTab = ws.activeTab;
            if (activeTab === id) activeTab = history.find((h) => tabs.some((t) => t.id === h)) ?? tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
            return { ...ws, tabs, activeTab, history };
          });
          set((s) => {
            const { [id]: _gone, ...dirty } = s.dirty;
            return { dirty };
          });
        },
        closeOthers: (id) => mutateWs((ws) => ({ ...ws, tabs: ws.tabs.filter((t) => t.id === id), activeTab: id, history: [id] })),
        closeAll: () => {
          mutateWs((ws) => ({ ...ws, tabs: [], activeTab: null, history: [] }));
          set({ dirty: {} });
        },
        activateTab: (id) => mutateWs((ws) => (ws.tabs.some((t) => t.id === id) ? { ...ws, activeTab: id, history: [id, ...ws.history.filter((h) => h !== id)].slice(0, 60) } : ws)),
        pinTab: (id) => mutateWs((ws) => ({ ...ws, tabs: ws.tabs.map((t) => (t.id === id && "preview" in t ? ({ ...t, preview: false } as Tab) : t)) })),
        updateTab: (id, patch) => mutateWs((ws) => ({ ...ws, tabs: ws.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) })),
        setDirty: (id, dirty) =>
          set((s) => {
            if (!!s.dirty[id] === dirty) return s;
            const next = { ...s.dirty };
            if (dirty) next[id] = true;
            else delete next[id];
            return { dirty: next };
          }),
        setActiveSession: (id) => mutateWs((ws) => ({ ...ws, activeSession: id })),
        setActiveSessionIn: (wsId, id) => set((s) => ({ byWs: { ...s.byWs, [wsId]: { ...(s.byWs[wsId] ?? emptyWs()), activeSession: id } } })),
        toggleExpanded: (path, open) =>
          mutateWs((ws) => {
            const has = ws.expanded.includes(path);
            const want = open ?? !has;
            if (want === has) return ws;
            return { ...ws, expanded: want ? [...ws.expanded, path] : ws.expanded.filter((p) => p !== path) };
          }),
      };
    },
    {
      name: "trb.ui.v1",
      storage: createJSONStorage(() => lazyStorage),
      version: 3,
      // v2: the Checklists factory page moved to the Lab. A saved factory tab on it lands on Portfolio instead of a page that is gone.
      // v3: the Lab tab was split into Findings, Bugs and Checklists. A saved Lab tab opens as Findings.
      migrate: (persisted) => {
        const s = persisted as { byWs?: Record<string, Partial<WsState>> } | null;
        if (!s?.byWs) return persisted as UiState;
        const byWs = Object.fromEntries(Object.entries(s.byWs).map(([id, ws]) => [id, migrateSavedWs(ws)]));
        return { ...s, byWs } as UiState;
      },
      // Theme is owned by localStorage "trb.theme" (read before paint); never let an old persisted copy override it.
      merge: (persisted, current) => ({ ...current, ...(persisted as object), themePref: current.themePref, palette: current.palette, theme: current.theme, glass: current.glass }),
      partialize: (s) => ({ activity: s.activity, leftOpen: s.leftOpen, rightOpen: s.rightOpen, rightTab: s.rightTab, bottomOpen: s.bottomOpen, bottomTab: s.bottomTab, leftW: s.leftW, rightW: s.rightW, bottomH: s.bottomH, panes: s.panes, byWs: s.byWs }),
    },
  ),
);

const EMPTY: WsState = emptyWs();

/** The current workspace's state. Stable reference when nothing changed. */
export function useWs(): WsState {
  return useUi((s) => (s.current ? (s.byWs[s.current] ?? EMPTY) : EMPTY));
}
