import { memo, useEffect, useMemo } from "react";
import { Navigate } from "./Navigate";
import { useUi, useWs } from "@/lib/store";
import { useGitStatus, useGlobalStream, useRoot, useSession, useWorkspaceVisit, useWorkspaces } from "@/lib/queries";
import { WorkspaceContext } from "@/lib/workspace";
import { useElementSize, useHotkey } from "@/lib/hooks";
import { bus } from "@/lib/bus";
import { fitPanes, maxSideWidth } from "./pane-fit";
import { Splitter } from "@/components/ui/splitter";
import { Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { TitleBar } from "./TitleBar";
import { ActivityBar } from "./ActivityBar";
import { EditorArea } from "./EditorArea";
import { StatusBar } from "./StatusBar";
import { QuickOpen } from "./QuickOpen";
import { CommandPalette } from "./CommandPalette";
import { RightPanel } from "./RightPanel";
import { BottomPanel } from "./BottomPanel";
import { useShellCommands } from "./commands";
import { closeTabGuarded } from "./closeTab";
import { HeadsCommands } from "@/features/heads/HeadsCommands";
import { SessionsSidebar } from "@/features/sessions/SessionsSidebar";
import { ExplorerSidebar } from "@/features/explorer/ExplorerSidebar";
import { SearchSidebar } from "@/features/search/SearchSidebar";
import { GitSidebar } from "@/features/git/GitSidebar";
import { SettingsSidebar } from "@/features/settings/SettingsSidebar";
import { SpecsSidebar } from "@/features/specs/SpecsSidebar";
import { DocsSidebar } from "@/features/docs/DocsSidebar";

const SIDEBARS = {
  sessions: memo(SessionsSidebar),
  explorer: memo(ExplorerSidebar),
  search: memo(SearchSidebar),
  git: memo(GitSidebar),
  specs: memo(SpecsSidebar),
  docs: memo(DocsSidebar),
  settings: memo(SettingsSidebar),
} as const;

/** A collapsed pane stays mounted (its drafts and streams survive) but skips layout and paint until it is shown again. */
const HIDDEN = { contentVisibility: "hidden" } as const;

export function Shell({ workspaceId }: { workspaceId: string }) {
  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  const root = useRoot(workspace ? workspaceId : null);
  const setCurrent = useUi((s) => s.setCurrent);

  useEffect(() => {
    setCurrent(workspaceId);
    return () => setCurrent(null);
  }, [workspaceId, setCurrent]);

  if (workspaces.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (!workspace) return <Navigate to="/" />;

  return (
    <WorkspaceContext.Provider value={{ workspace, root: workspaceId, repo: root.data?.repo }}>
      <Layout workspaceId={workspaceId} />
    </WorkspaceContext.Provider>
  );
}

function Layout({ workspaceId }: { workspaceId: string }) {
  // Select each field: a bare useUi() re-renders the whole shell on every store write, including each pixel of a splitter drag.
  const activity = useUi((s) => s.activity);
  const leftOpen = useUi((s) => s.leftOpen);
  const rightOpen = useUi((s) => s.rightOpen);
  const bottomOpen = useUi((s) => s.bottomOpen);
  const leftW = useUi((s) => s.leftW);
  const rightW = useUi((s) => s.rightW);
  const bottomH = useUi((s) => s.bottomH);
  const { setSize, toggleLeft, toggleRight, toggleBottom, setActivity } = useUi.getState();
  const ws = useWs();
  const session = useSession(ws.activeSession);
  useGlobalStream(workspaceId);
  useWorkspaceVisit(workspaceId);
  const git = useGitStatus(workspaceId);
  useShellCommands();

  // Keyboard: the ones an editor user expects. Cmd/Ctrl-W, T and N belong to the browser, so tab-closing is Alt-W.
  useHotkey({ key: "p", mod: true }, () => bus.emit("open-quick-open"), { allowInInput: true });
  useHotkey({ key: "p", mod: true, shift: true }, () => bus.emit("open-command-palette"), { allowInInput: true });
  useHotkey({ key: "k", mod: true }, () => bus.emit("open-command-palette"), { allowInInput: true });
  useHotkey({ key: "b", mod: true }, toggleLeft, { allowInInput: true });
  useHotkey({ key: "b", mod: true, alt: true }, toggleRight, { allowInInput: true });
  useHotkey({ key: "j", mod: true }, toggleBottom, { allowInInput: true });
  useHotkey({ key: "e", mod: true, shift: true }, () => setActivity("explorer"), { allowInInput: true });
  useHotkey({ key: "f", mod: true, shift: true }, () => setActivity("search"), { allowInInput: true });
  useHotkey({ key: "g", mod: true, shift: true }, () => setActivity("git"), { allowInInput: true });
  useHotkey({ key: "i", mod: true }, () => bus.emit("focus-composer"), { allowInInput: true });
  useHotkey({ key: "w", alt: true }, () => ws.activeTab && void closeTabGuarded(ws.activeTab), { allowInInput: true });
  // Ctrl-` toggles the terminal (the one binding every editor shares).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") {
        e.preventDefault();
        toggleBottom();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [toggleBottom]);

  const Sidebar = SIDEBARS[activity];
  const heads = session.data?.children.filter((c) => c.status !== "closed") ?? [];
  const runningHeads = useMemo(() => heads.filter((h) => h.status === "running").length, [heads]);
  // The side panes shrink, when both are wide, so the middle column keeps its minimum width.
  const [rowRef, row] = useElementSize<HTMLDivElement>();
  const fit = fitPanes(row.width, { leftW, rightW, leftOpen, rightOpen });

  return (
    <div className="flex h-full flex-col bg-window">
      <TitleBar runningHeads={runningHeads} />
      <div ref={rowRef} className="flex min-h-0 flex-1">
        <ActivityBar changes={git.data?.files.length ?? 0} runningHeads={runningHeads} />
        <div className={cn("shrink-0 overflow-hidden border-r border-line bg-chrome transition-[width] duration-200 ease-out")} style={{ width: leftOpen ? fit.left : 0, borderRightWidth: leftOpen ? 1 : 0 }}>
          <div style={leftOpen ? { width: fit.left } : { width: fit.left, ...HIDDEN }} className="h-full">
            <div key={activity} className="h-full animate-slide-right">
              <Sidebar />
            </div>
          </div>
        </div>
        {leftOpen && <Splitter axis="x" value={fit.left} min={200} max={560} onChange={(v) => setSize("leftW", Math.min(v, maxSideWidth(row.width, fit.right, rightOpen)))} onDoubleClick={() => setSize("leftW", 280)} className="-ml-px" />}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1">
            <EditorArea />
          </div>
          {bottomOpen && (
            <>
              <Splitter axis="y" invert value={bottomH} min={120} max={800} onChange={(v) => setSize("bottomH", v)} onDoubleClick={() => setSize("bottomH", 280)} />
              <div style={{ height: bottomH }} className="shrink-0 animate-slide-up bg-panel">
                <BottomPanel />
              </div>
            </>
          )}
        </div>

        {rightOpen && <Splitter axis="x" invert value={fit.right} min={320} max={760} onChange={(v) => setSize("rightW", Math.min(v, maxSideWidth(row.width, fit.left, leftOpen)))} onDoubleClick={() => setSize("rightW", 440)} />}
        <div className="shrink-0 overflow-hidden bg-panel transition-[width] duration-200 ease-out" style={{ width: rightOpen ? fit.right : 0 }}>
          <div style={rightOpen ? { width: fit.right } : { width: fit.right, ...HIDDEN }} className="h-full">
            <RightPanel headCount={heads.length} runningHeads={runningHeads} />
          </div>
        </div>
      </div>
      <StatusBar />
      <QuickOpen />
      <CommandPalette />
      <HeadsCommands />
    </div>
  );
}
