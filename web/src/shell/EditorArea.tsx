import { lazy, memo, Suspense, useEffect, useRef } from "react";
import { PaneBoundary } from "@/components/PaneBoundary";
import { Brain, ClipboardCheck, FileDiff, Factory, Fingerprint, FlaskConical, Globe, Smartphone, GitCommitHorizontal, Kanban, ListChecks, ScrollText, Settings2, X, BookText, ClipboardList, History, Palette } from "lucide-react";
import { useUi, useWs, type Tab } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ContextMenu } from "@/components/ui/overlay";
import { StatusDot } from "@/components/ui/misc";
import { Welcome } from "./Welcome";
import { FileIcon } from "./FileIcon";
import { useSession } from "@/lib/queries";
import { closeManyGuarded, closeTabGuarded } from "./closeTab";

// Each tab kind is its own chunk: the editor, terminal and settings code load when first opened, not at startup.
const FileTab = lazy(() => import("@/features/editor/FileTab").then((m) => ({ default: m.FileTab })));
const DiffTab = lazy(() => import("@/features/git/DiffTab").then((m) => ({ default: m.DiffTab })));
const CommitTab = lazy(() => import("@/features/git/CommitTab").then((m) => ({ default: m.CommitTab })));
const BrowserTab = lazy(() => import("@/features/browser/BrowserTab").then((m) => ({ default: m.BrowserTab })));
const SettingsTab = lazy(() => import("@/features/settings/SettingsTab").then((m) => ({ default: m.SettingsTab })));
const SessionTab = lazy(() => import("@/features/session/SessionTab").then((m) => ({ default: m.SessionTab })));
const RoadmapTab = lazy(() => import("@/features/roadmap/RoadmapTab").then((m) => ({ default: m.RoadmapTab })));
const DesignTab = lazy(() => import("@/features/design/DesignTab").then((m) => ({ default: m.DesignTab })));
const FindingsTab = lazy(() => import("@/features/lab/FindingsTab").then((m) => ({ default: m.FindingsTab })));
const EmulatorView = lazy(() => import("@/features/emulator/EmulatorView").then((m) => ({ default: m.EmulatorView })));
const QaTab = lazy(() => import("@/features/qa/QaTab").then((m) => ({ default: m.QaTab })));
const ChecklistsTab = lazy(() => import("@/features/lab/ChecklistsTab").then((m) => ({ default: m.ChecklistsTab })));
const EvidenceTab = lazy(() => import("@/features/evidence/EvidenceTab").then((m) => ({ default: m.EvidenceTab })));
const FactoryView = lazy(() => import("@/features/factory/FactoryView").then((m) => ({ default: m.FactoryView })));
const MemoryTab = lazy(() => import("@/features/memory/MemoryTab").then((m) => ({ default: m.MemoryTab })));
const TranscriptsTab = lazy(() => import("@/features/transcripts/TranscriptsTab").then((m) => ({ default: m.TranscriptsTab })));
const SpecWorkbench = lazy(() => import("@/features/specs/SpecWorkbench").then((m) => ({ default: m.SpecWorkbench })));
const DocViewer = lazy(() => import("@/features/docs/DocViewer").then((m) => ({ default: m.DocViewer })));
const PlanViewer = lazy(() => import("@/features/agent/PlanViewer").then((m) => ({ default: m.PlanViewer })));

function SessionTabDot({ id }: { id: string }) {
  const s = useSession(id);
  return <StatusDot status={s.data?.session.status ?? "idle"} />;
}

function TabIcon({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "file":
      return <FileIcon name={tab.path} className="size-3.5" />;
    case "diff":
      return <FileDiff className="size-3.5 text-amber" />;
    case "commit":
      return <GitCommitHorizontal className="size-3.5 text-violet" />;
    case "browser":
      return <Globe className="size-3.5 text-blue" />;
    case "settings":
      return <Settings2 className="size-3.5 text-fg-muted" />;
    case "session":
      return <SessionTabDot id={tab.sessionId} />;
    case "spec":
      return <ScrollText className="size-3.5 text-accent" />;
    case "doc":
      return <BookText className="size-3.5 text-blue" />;
    case "plan":
      return <ClipboardList className="size-3.5 text-violet" />;
    case "roadmap":
      return <Kanban className="size-3.5 text-accent" />;
    case "design":
      return <Palette className="size-3.5 text-accent" />;
    case "findings":
      return <FlaskConical className="size-3.5 text-accent" />;
    case "checklists":
      return <ListChecks className="size-3.5 text-accent" />;
    case "qa":
      return <ClipboardCheck className="size-3.5 text-accent" />;
    case "emulator":
      return <Smartphone className="size-3.5 text-accent" />;
    case "memory":
      return <Brain className="size-3.5 text-accent" />;
    case "evidence":
      return <Fingerprint className="size-3.5 text-accent" />;
    case "factory":
      return <Factory className="size-3.5 text-accent" />;
    case "transcripts":
      return <History className="size-3.5 text-accent" />;
  }
}

function TabStrip() {
  const ws = useWs();
  const activateTab = useUi((s) => s.activateTab);
  const pinTab = useUi((s) => s.pinTab);
  const dirty = useUi((s) => s.dirty);
  const scroller = useRef<HTMLDivElement>(null);

  // Keep the active tab in view, and let the wheel scroll the strip sideways.
  useEffect(() => {
    scroller.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [ws.activeTab, ws.tabs.length]);

  return (
    <div ref={scroller} onWheel={(e) => scroller.current && e.deltaY !== 0 && (scroller.current.scrollLeft += e.deltaY)} role="tablist" className="flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-line bg-bg [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {ws.tabs.map((tab) => {
        const active = tab.id === ws.activeTab;
        const isDirty = dirty[tab.id];
        const preview = "preview" in tab && tab.preview;
        return (
          <ContextMenu
            key={tab.id}
            entries={[
              { label: "Close", onSelect: () => void closeTabGuarded(tab.id), shortcut: "Alt+W" },
              { label: "Close others", onSelect: () => void closeManyGuarded(ws.tabs.filter((t) => t.id !== tab.id).map((t) => t.id)), disabled: ws.tabs.length < 2 },
              { label: "Close all", onSelect: () => void closeManyGuarded(ws.tabs.map((t) => t.id)) },
              ...(tab.kind === "file" ? [{ separator: true }, { label: "Copy path", onSelect: () => navigator.clipboard.writeText(tab.path) }] : []),
            ]}
          >
            <div
              role="tab"
              aria-selected={active}
              data-active={active}
              onClick={() => activateTab(tab.id)}
              onDoubleClick={() => pinTab(tab.id)}
              onAuxClick={(e) => e.button === 1 && void closeTabGuarded(tab.id)}
              className={cn("group relative flex min-w-0 max-w-[220px] shrink-0 cursor-default items-center gap-1.5 border-r border-line px-3 text-[12.5px] outline-none transition-colors", active ? "bg-panel text-fg" : "text-fg-muted hover:bg-hover hover:text-fg")}
            >
              <span className={cn("absolute inset-x-0 top-0 h-px origin-left bg-accent transition-transform duration-200", active ? "scale-x-100" : "scale-x-0")} />
              <TabIcon tab={tab} />
              <span className={cn("truncate", preview && "italic")}>{tab.title}</span>
              <button
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTabGuarded(tab.id);
                }}
                className="relative -mr-1 flex size-4 shrink-0 items-center justify-center rounded text-fg-faint outline-none hover:bg-active hover:text-fg"
              >
                {isDirty ? <span className="size-2 rounded-full bg-fg-muted group-hover:hidden" /> : null}
                <X className={cn("size-3", isDirty ? "hidden group-hover:block" : active ? "opacity-100" : "opacity-0 group-hover:opacity-100")} />
              </button>
            </div>
          </ContextMenu>
        );
      })}
    </div>
  );
}

const PANE_NAMES: Record<string, string> = { file: "Editor", diff: "Diff", commit: "Commit", browser: "Browser", settings: "Settings", session: "Session", spec: "Spec", doc: "Document", plan: "Plan", roadmap: "Roadmap", design: "Design", memory: "Memory", transcripts: "Session replay", factory: "Factory" };

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "file":
      return <FileTab tab={tab} />;
    case "diff":
      return <DiffTab tab={tab} />;
    case "commit":
      return <CommitTab tab={tab} />;
    case "browser":
      return <BrowserTab tab={tab} />;
    case "settings":
      return <SettingsTab tab={tab} />;
    case "session":
      return <SessionTab tab={tab} />;
    case "spec":
      return <SpecWorkbench tab={tab} />;
    case "doc":
      return <DocViewer tab={tab} />;
    case "plan":
      return <PlanViewer tab={tab} />;
    case "roadmap":
      return <RoadmapTab />;
    case "design":
      return <DesignTab />;
    case "findings":
      return <FindingsTab />;
    case "checklists":
      return <ChecklistsTab />;
    case "qa":
      return <QaTab />;
    case "emulator":
      return <EmulatorView />;
    case "memory":
      return <MemoryTab />;
    case "evidence":
      return <EvidenceTab />;
    case "factory":
      return <FactoryView tab={tab} />;
    case "transcripts":
      return <TranscriptsTab />;
  }
}

export const EditorArea = memo(function EditorArea() {
  const ws = useWs();
  const active = ws.tabs.find((t) => t.id === ws.activeTab);
  return (
    <div className="flex h-full min-w-0 flex-col bg-panel">
      {ws.tabs.length > 0 && <TabStrip />}
      <div className="min-h-0 flex-1">
        {active ? (
          <div key={active.id} className="h-full animate-in fade-in-0 duration-150">
            <PaneBoundary name={PANE_NAMES[active.kind] ?? "Tab"}>
              <Suspense fallback={null}>
                <TabContent tab={active} />
              </Suspense>
            </PaneBoundary>
          </div>
        ) : (
          <Welcome />
        )}
      </div>
    </div>
  );
});
