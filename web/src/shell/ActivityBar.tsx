import { useEffect, useState } from "react";
import { Bot, Bug, ClipboardCheck, Factory, FlaskConical, ListChecks, Files, GitBranch, Kanban, Palette, ScrollText, Search, Settings2, BookText, Fingerprint, Smartphone } from "lucide-react";
import { useUi, useWs, type Activity } from "@/lib/store";
import { openFactory } from "@/features/factory/open";
import { openEmulator } from "@/features/emulator/open";
import { openBugs, openChecklists, openFindings, openQa } from "@/features/lab/open";
import { useLabCounts } from "@/features/lab/data";
import { useEvidenceSwitches } from "@/features/evidence/data";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/overlay";
import { formatCombo } from "@/lib/hooks";
import { ProviderUsage } from "@/features/agent/UsageHover";

const ITEMS: Array<{ id: Activity; label: string; icon: React.ReactNode; shortcut?: string }> = [
  { id: "sessions", label: "Sessions", icon: <Bot /> },
  { id: "explorer", label: "Explorer", icon: <Files />, shortcut: formatCombo({ key: "e", mod: true, shift: true }) },
  { id: "search", label: "Search", icon: <Search />, shortcut: formatCombo({ key: "f", mod: true, shift: true }) },
  { id: "git", label: "Source control", icon: <GitBranch />, shortcut: formatCombo({ key: "g", mod: true, shift: true }) },
  { id: "specs", label: "Specs", icon: <ScrollText /> },
  { id: "docs", label: "Docs", icon: <BookText /> },
];

type TabView = "roadmap" | "design" | "findings" | "bugs" | "checklists" | "qa" | "emulator" | "evidence" | "factory";
const TAB_VIEWS: readonly string[] = ["roadmap", "design", "findings", "bugs", "checklists", "qa", "emulator", "evidence", "factory"];

const isTabView = (id: string | null): id is TabView => id !== null && TAB_VIEWS.includes(id);

const countBadge = (n: number) => (n > 0 ? <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-accent px-1 text-center font-mono text-[9px] font-semibold leading-4 text-accent-fg">{n > 99 ? "99+" : n}</span> : undefined);

export function ActivityBar({ changes, runningHeads }: { changes: number; runningHeads: number }) {
  const { activity, leftOpen, setActivity, openTab } = useUi();
  const ws = useWs();
  const current = useUi((s) => s.current);
  const labCounts = useLabCounts(current).data;
  // Evidence is on by default: its button is always there, dimmed only once the operator has switched it off (the tab itself offers the switch).
  const evidenceOn = useEvidenceSwitches().status.data?.evidence ?? true;
  // The sidebar and a tab view (roadmap, design) can both be showing; only the one touched last is highlighted.
  const tabView = (t: string | null): TabView | null => (isTabView(t) ? t : null);
  const [tabFocus, setTabFocus] = useState<TabView | null>(tabView(ws.activeTab));
  useEffect(() => setTabFocus(tabView(ws.activeTab)), [ws.activeTab]);
  const focusedTab = tabFocus && ws.activeTab === tabFocus ? tabFocus : null;
  // A view that opens as a tab in the editor area instead of in the sidebar (the roadmap is a board, the design view a page: they need the room).
  const item = (id: Activity | TabView, label: string, icon: React.ReactNode, shortcut: string | undefined, badge?: React.ReactNode, off = false) => {
    const isTab = isTabView(id);
    const active = isTab ? focusedTab === id : activity === id && leftOpen && !focusedTab;
    return (
      <Tooltip key={id} label={off ? `${label} (off: click to set up)` : label} shortcut={shortcut} side="right">
        <button onClick={() => {
            setTabFocus(isTab ? id : null);
            if (id === "roadmap") openTab({ kind: "roadmap", title: "Roadmap" });
            else if (id === "design") openTab({ kind: "design", title: "Design" });
            else if (id === "findings") openFindings();
            else if (id === "bugs") openBugs();
            else if (id === "checklists") openChecklists();
            else if (id === "qa") openQa();
            else if (id === "emulator") openEmulator();
            else if (id === "evidence") openTab({ kind: "evidence", title: "Evidence" });
            else if (id === "factory") openFactory();
            else setActivity(id);
          }} aria-label={label} aria-pressed={active} className={cn("group relative flex size-10 items-center justify-center rounded-lg outline-none transition-colors [&_svg]:size-[19px]", active ? "text-fg" : "text-fg-faint hover:text-fg", off && !active && "opacity-40")}>
          <span className={cn("absolute left-0 top-2.5 h-5 w-[2px] origin-center rounded-r bg-accent transition-transform duration-200", active ? "scale-y-100" : "scale-y-0")} />
          <span className={cn("absolute inset-1 rounded-lg transition-colors", active ? "bg-hover" : "group-hover:bg-hover")} />
          <span className="relative">{icon}</span>
          {badge}
        </button>
      </Tooltip>
    );
  };
  return (
    <nav className="flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-chrome py-1.5">
      {ITEMS.map((it) => {
        let badge: React.ReactNode = null;
        if (it.id === "git" && changes > 0) badge = <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-accent px-1 text-center font-mono text-[9px] font-semibold leading-4 text-accent-fg animate-pop">{changes > 99 ? "99+" : changes}</span>;
        if (it.id === "sessions" && runningHeads > 0) badge = <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent animate-pulse-dot" />;
        return item(it.id, it.label, it.icon, it.shortcut, badge);
      })}
      {item("roadmap", "Roadmap", <Kanban />, undefined)}
      {item("design", "Design", <Palette />, undefined)}
      {item("findings", "Findings", <FlaskConical />, undefined, countBadge(labCounts?.open ?? 0))}
      {item("bugs", "Bugs", <Bug />, undefined, countBadge(labCounts?.bugs ?? 0))}
      {item("checklists", "Checklists", <ListChecks />, undefined)}
      {item("qa", "QA", <ClipboardCheck />, undefined)}
      {item("emulator", "Emulator", <Smartphone />, undefined)}
      {item("factory", "Factory", <Factory />, undefined)}
      {item("evidence", "Evidence", <Fingerprint />, undefined, undefined, !evidenceOn)}
      <div className="flex-1" />
      <ProviderUsage />
      {item("settings", "Settings", <Settings2 />, undefined)}
    </nav>
  );
}
