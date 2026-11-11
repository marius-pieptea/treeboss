import { useState } from "react";
import { Blocks, BookOpen, Cpu, FolderCog, Info, Layers, LayoutTemplate, ListChecks, Palette, Search, ShieldCheck, SlidersHorizontal, Smartphone, UserRoundCog } from "lucide-react";
import { Input } from "@/components/ui/form";
import { useAgents, useEngines, usePairs } from "@/lib/queries";
import { useUi, useWs, type SettingsPage } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useConfig, useDoctor, useMcp, useSkills } from "./data";
import { openSettingsPage, registerSettingsCommands } from "./commands";
import { settingMatches, settingMeta } from "./logic";
import { useSettingsUi } from "./ui-state";

registerSettingsCommands();

function Item({ page, icon, label, hint, count, active, dot, delay }: { page: SettingsPage; icon: React.ReactNode; label: string; hint: string; count?: React.ReactNode; active: boolean; dot?: "ok" | "warn" | "fail"; delay: number }) {
  return (
    <button onClick={() => openSettingsPage(page)} aria-current={active ? "page" : undefined} style={{ animationDelay: `${delay}ms` }} className={cn("group relative flex w-full animate-slide-right items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:bg-hover", active ? "bg-active" : "hover:bg-hover")}>
      <span className={cn("absolute left-0 top-2.5 h-4 w-[2px] rounded-r bg-accent transition-transform duration-200", active ? "scale-y-100" : "scale-y-0")} />
      <span className={cn("mt-0.5 [&_svg]:size-4", active ? "text-accent" : "text-fg-faint group-hover:text-fg-muted")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          {label}
          {dot && <span className={cn("size-1.5 rounded-full", dot === "ok" ? "bg-green" : dot === "warn" ? "bg-amber" : "bg-red")} aria-label={`health: ${dot}`} />}
        </span>
        <span className="block truncate text-[11.5px] text-fg-muted">{hint}</span>
      </span>
      {count !== undefined && <span className="mt-0.5 rounded bg-raised px-1.5 font-mono text-[10.5px] text-fg-muted">{count}</span>}
    </button>
  );
}

export function SettingsSidebar() {
  const ws = useWs();
  const pairs = usePairs();
  const agents = useAgents();
  const mcp = useMcp();
  const skills = useSkills();
  const engines = useEngines();
  const doctor = useDoctor();
  const config = useConfig();
  const [query, setQuery] = useState("");
  const activePage = useUi((s) => s.byWs[s.current ?? ""]?.tabs.find((t) => t.id === ws.activeTab && t.kind === "settings"));
  const page = activePage && activePage.kind === "settings" ? activePage.page : null;

  const mcpOn = mcp.data?.filter((s) => s.enabled).length ?? 0;
  const skillsOn = skills.data?.filter((s) => s.enabled).length ?? 0;
  const installed = engines.data?.filter((e) => e.installed).length ?? 0;

  const modules: Array<{ page: SettingsPage; icon: React.ReactNode; label: string; hint: string; count?: React.ReactNode; dot?: "ok" | "warn" | "fail" }> = [
    { page: "agents", icon: <UserRoundCog />, label: "Agents", hint: "Instructions, skills and tools", count: agents.data?.length },
    { page: "pairs", icon: <Layers />, label: "Hydra pairs", hint: "Who leads, what heads run", count: pairs.data?.length },
    { page: "mcp", icon: <Blocks />, label: "MCP servers", hint: "Tools agents can call", count: mcp.data ? `${mcpOn}/${mcp.data.length}` : undefined },
    { page: "skills", icon: <BookOpen />, label: "Skills", hint: "Reusable instructions", count: skills.data ? `${skillsOn}/${skills.data.length}` : undefined },
    { page: "engines", icon: <Cpu />, label: "Engines", hint: "Installed coding CLIs", count: engines.data ? `${installed}/${engines.data.length}` : undefined, dot: doctor.data?.status },
    { page: "workspace", icon: <FolderCog />, label: "Workspace", hint: "Plans, docs and roadmap folders" },
    { page: "templates", icon: <LayoutTemplate />, label: "Templates", hint: "New app recipes, editable" },
    { page: "checklists", icon: <ListChecks />, label: "Checklists", hint: "Launch checklists, editable" },
    { page: "design-systems", icon: <Palette />, label: "Design systems", hint: "DESIGN.md + tokens for new apps" },
    { page: "verify", icon: <ShieldCheck />, label: "Verification", hint: "Checks after each turn" },
    { page: "practices", icon: <ListChecks />, label: "Practices", hint: "Rules and checks for agents" },
    { page: "remote", icon: <Smartphone />, label: "Remote access", hint: "Pair a phone, paired devices" },
    { page: "config", icon: <SlidersHorizontal />, label: "Daemon settings", hint: "Limits, timeouts, isolation" },
    { page: "about", icon: <Info />, label: "About", hint: "Version and updates" },
  ];
  const searching = query.trim() !== "";
  const shownModules = modules.filter((m) => !searching || settingMatches(query, { key: m.page, label: m.label, group: "", help: m.hint }));
  const hits = searching ? (config.data ?? []).filter((s) => { const m = settingMeta(s.key, s.default); return settingMatches(query, { key: s.key, label: m.label, group: m.group, help: s.help }); }) : [];

  const findSetting = (key: string) => {
    useSettingsUi.getState().focusSetting(key);
    openSettingsPage("config");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center px-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Settings</div>
      <div className="relative px-1.5 pb-1.5">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} placeholder="Search settings" aria-label="Search settings" spellCheck={false} className="h-7 pl-7 text-xs" />
      </div>
      <nav className="flex flex-col gap-0.5 overflow-y-auto px-1.5" aria-label="Settings">
        {shownModules.map((m, i) => (
          <Item key={m.page} delay={Math.min(i * 25, 150)} active={page === m.page} {...m} />
        ))}
        {searching && shownModules.length === 0 && <p className="px-2.5 py-2 text-[11.5px] text-fg-muted">No module matches.</p>}
        {searching && hits.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Daemon settings</div>
            {hits.map((s) => (
              <button key={s.key} onClick={() => findSetting(s.key)} className="flex w-full flex-col items-start rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover">
                <span className="text-[13px] font-medium">{settingMeta(s.key, s.default).label}</span>
                <span className="font-mono text-[10.5px] text-fg-faint">{s.key} · {settingMeta(s.key, s.default).group}</span>
              </button>
            ))}
          </div>
        )}
      </nav>
      <p className="mt-auto px-4 py-3 text-[11px] leading-relaxed text-fg-faint">Changes apply to the next turn of every session. The same settings are available from the terminal: <span className="font-mono">trb agent, pair, mcp, skill, config</span>.</p>
    </div>
  );
}
