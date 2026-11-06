import { Bot, ChevronsUpDown, FolderOpen, Globe, GitBranch, Monitor, Moon, Palette, PanelBottom, PanelLeft, PanelRight, Search, Smartphone, Sun } from "lucide-react";
import { useUi } from "@/lib/store";
import { THEME_OPTIONS } from "@/lib/theme";
import { glassSupported } from "@/lib/glass";
import { useGitStatus, useWorkspaceActivity, useWorkspaces } from "@/lib/queries";
import { useWorkspace } from "@/lib/workspace";
import { navigate } from "@/lib/nav";
import { bus } from "@/lib/bus";
import { formatCombo } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/overlay";
import { Kbd } from "@/components/ui/misc";
import { Logo } from "./Logo";
import { openBrowserTab } from "@/features/browser/discover";
import { openEmulator } from "@/features/emulator/open";

/** Running / failed work in a workspace, shown next to its name in the switcher. */
function ActivityChip({ a }: { a?: { running: number; failed: number } }) {
  if (!a) return null;
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10.5px]">
      {a.running > 0 && (
        <span className="flex items-center gap-1 text-accent">
          <span className="size-1.5 rounded-full bg-accent animate-pulse-dot" />
          {a.running}
        </span>
      )}
      {a.failed > 0 && <span className="text-red">{a.failed} failed</span>}
    </span>
  );
}

export function TitleBar({ runningHeads }: { runningHeads: number }) {
  const { workspace, root } = useWorkspace();
  const workspaces = useWorkspaces();
  const git = useGitStatus(root);
  const activity = useWorkspaceActivity().data ?? {};
  const elsewhere = Object.entries(activity).filter(([id]) => id !== workspace.id);
  const elsewhereRunning = elsewhere.reduce((n, [, a]) => n + a.running, 0);
  const elsewhereFailed = elsewhere.reduce((n, [, a]) => n + a.failed, 0);
  const { theme, themePref, palette, glass, setGlass, setTheme, leftOpen, rightOpen, bottomOpen, toggleLeft, toggleRight, toggleBottom, setActivity } = useUi();

  return (
    <header className="app-titlebar flex h-10 shrink-0 items-center gap-2 border-b border-line bg-chrome px-2">
      <button onClick={() => navigate("/")} className="rounded-md p-1 outline-none transition-transform hover:scale-105 active:scale-95" aria-label="Home">
        <Logo size={22} />
      </button>

      <DropdownMenu
        entries={[
          ...(workspaces.data ?? []).map((w) => ({ label: w.name, checked: w.id === workspace.id, onSelect: () => navigate(`/w/${w.id}`), badge: <ActivityChip a={activity[w.id]} /> })),
        ]}
        footer={[{ label: "Open another folder…", icon: <FolderOpen />, onSelect: () => navigate("/") }]}
        trigger={
          <button className="flex h-7 max-w-[240px] items-center gap-1.5 rounded-md px-2 text-[13px] font-medium outline-none transition-colors hover:bg-hover">
            <span className="truncate">{workspace.name}</span>
            <ChevronsUpDown className="size-3 shrink-0 text-fg-faint" />
            {(elsewhereRunning > 0 || elsewhereFailed > 0) && (
              <span title={`${elsewhereRunning} running, ${elsewhereFailed} failed in other workspaces`} className={cn("size-1.5 shrink-0 rounded-full", elsewhereFailed > 0 ? "bg-red" : "bg-accent animate-pulse-dot")} />
            )}
          </button>
        }
      />

      {git.data && (git.data.branch || git.data.detached) && (
        <button onClick={() => setActivity("git")} className="flex h-6 items-center gap-1.5 rounded-md border border-line bg-raised px-2 font-mono text-[11px] text-fg-muted outline-none transition-colors hover:border-line-strong hover:text-fg">
          <GitBranch className="size-3 text-accent" />
          <span className="max-w-[160px] truncate">{git.data.branch ?? `${git.data.head?.slice(0, 7)} (detached)`}</span>
          {(git.data.ahead > 0 || git.data.behind > 0) && (
            <span className="text-fg-faint">
              {git.data.ahead > 0 && `↑${git.data.ahead}`}
              {git.data.behind > 0 && `↓${git.data.behind}`}
            </span>
          )}
        </button>
      )}

      <div className="flex-1" />

      <button onClick={() => bus.emit("open-command-palette")} className="group flex h-7 w-[min(34vw,380px)] items-center gap-2 rounded-lg border border-line bg-raised px-2.5 text-xs text-fg-faint outline-none transition-colors hover:border-line-strong hover:text-fg-muted">
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Search files, run commands…</span>
        <Kbd>{formatCombo({ key: "k", mod: true })}</Kbd>
      </button>

      <div className="flex-1" />

      {runningHeads > 0 && (
        <div className="flex h-6 items-center gap-1.5 rounded-md bg-accent-soft px-2 font-mono text-[11px] text-accent animate-slide-up">
          <span className="size-1.5 rounded-full bg-accent animate-pulse-dot" />
          {runningHeads} head{runningHeads === 1 ? "" : "s"} working
        </div>
      )}
      <div className="flex items-center">
        <DropdownMenu
          align="end"
          entries={[
            { label: "Preview a dev server", icon: <Globe />, onSelect: () => openBrowserTab("preview") },
            { label: "Agent browser (watch an agent drive a page)", icon: <Bot />, onSelect: () => openBrowserTab("agent") },
            { label: "Android emulator (watch and drive the phone)", icon: <Smartphone />, onSelect: () => openEmulator() },
          ]}
          trigger={
            <IconButton label="Browser">
              <Globe />
            </IconButton>
          }
        />
        <IconButton label={leftOpen ? "Hide sidebar" : "Show sidebar"} shortcut={formatCombo({ key: "b", mod: true })} onClick={toggleLeft} className={cn(leftOpen && "text-fg")}>
          <PanelLeft />
        </IconButton>
        <IconButton label={bottomOpen ? "Hide terminal" : "Show terminal"} shortcut="Ctrl+`" onClick={toggleBottom} className={cn(bottomOpen && "text-fg")}>
          <PanelBottom />
        </IconButton>
        <IconButton label={rightOpen ? "Hide agent panel" : "Show agent panel"} shortcut={formatCombo({ key: "b", mod: true, alt: true })} onClick={toggleRight} className={cn(rightOpen && "text-fg")}>
          <PanelRight />
        </IconButton>
        <DropdownMenu
          align="end"
          entries={[
            ...THEME_OPTIONS.map((o) => ({ label: o.hint ? `${o.label} · ${o.hint}` : o.label, checked: o.value === themePref, onSelect: () => setTheme(o.value) })),
            ...(glassSupported() ? [{ separator: true }, { label: "Translucent sidebar", checked: glass, onSelect: () => setGlass(!glass) }] : []),
          ]}
          trigger={
            <IconButton label="Theme">
              {palette !== "default" ? <Palette /> : themePref === "system" ? <Monitor /> : theme === "dark" ? <Moon /> : <Sun />}
            </IconButton>
          }
        />
      </div>
    </header>
  );
}

