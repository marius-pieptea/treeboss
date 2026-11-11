import { openChecklists, openFindings } from "@/features/lab/open";
import { openQa } from "@/features/qa/open";
import { openFactory } from "@/features/factory/open";
import { openEmulator } from "@/features/emulator/open";
import { ListChecks, ClipboardCheck, Tag,ShieldCheck, Bot, Brain, Factory, FlaskConical, Compass, FolderOpen, FolderPlus, GitBranch, GitPullRequest, Kanban, KeyRound, Layers, Palette, PanelBottom, PanelLeft, PanelRight, Radio, ScrollText, Search, Settings2, Smartphone, SquareTerminal, X, BookText, FilePlus2, Gavel, Sparkles, History, Fingerprint } from "lucide-react";
import { useRegisterCommands, type Command } from "@/lib/commands";
import { useUi, useWs } from "@/lib/store";
import { bus } from "@/lib/bus";
import { THEME_OPTIONS } from "@/lib/theme";
import { glassSupported } from "@/lib/glass";
import { navigate } from "@/lib/nav";
import { formatCombo } from "@/lib/hooks";
import { closeManyGuarded, closeTabGuarded } from "./closeTab";
import { composeDesign } from "@/features/design/composer";
import { openNewInvestigation } from "@/features/evidence/open";

/** The shell's own commands: panels, navigation, theme, settings pages. Features add theirs separately. */
export function useShellCommands(): void {
  const ui = useUi();
  const ws = useWs();
  const cmds: Command[] = [
    { id: "open-file", group: "Go", title: "Go to file…", icon: <Search />, shortcut: formatCombo({ key: "p", mod: true }), run: () => bus.emit("open-quick-open") },
    { id: "ask", group: "Agent", title: "Ask an agent…", icon: <Bot />, shortcut: formatCombo({ key: "i", mod: true }), run: () => bus.emit("focus-composer") },
    { id: "new-session", group: "Agent", title: "New session", icon: <Bot />, keywords: "chat start", run: () => { ui.setActiveSession(null); ui.setRightTab("agent"); setTimeout(() => bus.emit("focus-composer"), 50); } },
    { id: "explorer", group: "View", title: "Show explorer", icon: <FolderOpen />, run: () => ui.setActivity("explorer") },
    { id: "search", group: "View", title: "Search in files", icon: <Search />, run: () => ui.setActivity("search") },
    { id: "git", group: "View", title: "Show source control", icon: <GitBranch />, run: () => ui.setActivity("git") },
    { id: "sessions", group: "View", title: "Show sessions", icon: <Bot />, run: () => ui.setActivity("sessions") },
    { id: "specs", group: "Specs", title: "Show specs", icon: <ScrollText />, keywords: "constitution plan tasks roadmap", run: () => ui.setActivity("specs") },
    { id: "specs-new", group: "Specs", title: "New feature spec…", icon: <FolderPlus />, keywords: "specify feature", run: () => { ui.setActivity("specs"); setTimeout(() => bus.emit("specs-new-feature"), 60); } },
    { id: "specs-architecture", group: "Specs", title: "Discuss architecture…", icon: <Compass />, keywords: "design spec plan", run: () => { ui.setActivity("specs"); setTimeout(() => bus.emit("specs-architecture"), 60); } },
    { id: "design-new", group: "Design", title: "Design: brainstorm a design system…", icon: <Palette />, keywords: "design.md tokens generate brief directions /design", run: () => composeDesign("brief") },
    { id: "design-review", group: "Design", title: "Design: review the UI against DESIGN.md", icon: <Palette />, keywords: "critique audit tokens /design review", run: () => composeDesign("review") },
    { id: "lab-review", group: "Lab", title: "Lab: review my uncommitted changes", icon: <FlaskConical />, keywords: "review diff bugs risks lab", run: () => openFindings({ lens: "review", scope: "diff" }) },
    { id: "lab-security", group: "Lab", title: "Lab: security pass on my changes", icon: <FlaskConical />, keywords: "security auth authorization authentication vulnerabilities secrets lab audit", run: () => openFindings({ lens: "security", scope: "diff" }) },
    { id: "lab-security-sweep", group: "Lab", title: "Lab: sweep modules for security issues…", icon: <FlaskConical />, keywords: "security auth authorization sweep audit lab", run: () => openFindings({ lens: "security", sweep: true }) },
    { id: "lab-ux", group: "Lab", title: "Lab: review user flows and UX…", icon: <FlaskConical />, keywords: "ux flows journey onboarding errors copy usability lab", run: () => openFindings({ lens: "ux", scope: "project" }) },
    { id: "lab-features", group: "Lab", title: "Lab: suggest features…", icon: <FlaskConical />, keywords: "ideas improvements product lab", run: () => openFindings({ lens: "features", scope: "project" }) },
    { id: "lab-ui", group: "Lab", title: "Lab: sweep the UI for improvements…", icon: <FlaskConical />, keywords: "ui ux design suggestions sweep lab", run: () => openFindings({ lens: "ui", sweep: true }) },
    { id: "lab-perf", group: "Lab", title: "Lab: sweep modules for performance…", icon: <FlaskConical />, keywords: "performance slow speed bundle sweep lab", run: () => openFindings({ lens: "perf", sweep: true }) },
    { id: "lab-ai", group: "Lab", title: "Lab: find AI opportunities…", icon: <FlaskConical />, keywords: "ai llm model automate lab", run: () => openFindings({ lens: "ai", scope: "project" }) },
    { id: "findings", group: "Lab", title: "Open Findings", icon: <FlaskConical />, keywords: "lab improve suggestions ideas sweep audit performance ui ai features review findings", run: () => openFindings() },
    { id: "checklists", group: "Lab", title: "Open Checklists", icon: <ListChecks />, keywords: "lab launch checklist prod deploy readiness required checks", run: () => openChecklists() },
    { id: "qa", group: "Lab", title: "Open QA", icon: <ClipboardCheck />, keywords: "qa test plan flows bugs fix features map", run: () => openQa() },
    { id: "emulator", group: "Mobile", title: "Open emulator", icon: <Smartphone />, keywords: "android phone device expo react native app avd", run: () => openEmulator() },
    { id: "design", group: "Design", title: "Open design system", icon: <Palette />, keywords: "design.md tokens colors typography brand theme", run: () => void ui.openTab({ kind: "design", title: "Design" }) },
    { id: "roadmap", group: "Roadmap", title: "Open roadmap", icon: <Kanban />, keywords: "board lanes timeline plan", run: () => void ui.openTab({ kind: "roadmap", title: "Roadmap" }) },
    { id: "evidence", group: "Evidence", title: "Open evidence", icon: <Fingerprint />, keywords: "captures pages screenshots styles findings notes clone reverse engineer rea website", run: () => void ui.openTab({ kind: "evidence", title: "Evidence" }) },
    { id: "evidence-new-investigation", group: "Evidence", title: "Evidence: new investigation…", icon: <Fingerprint />, keywords: "investigation study site app binary target findings build", run: () => openNewInvestigation() },
    { id: "factory", group: "Factory", title: "Open factory", icon: <Factory />, keywords: "portfolio autopilot ship pull request deploy release mobile signals secrets", run: () => openFactory() },
    { id: "factory-portfolio", group: "Factory", title: "Factory: portfolio", icon: <Layers />, keywords: "products repos budget spend", run: () => openFactory("portfolio") },
    { id: "factory-autopilot", group: "Factory", title: "Factory: autopilot runs and schedules", icon: <Bot />, keywords: "runs schedules cron approve gate queue", run: () => openFactory("autopilot") },
    { id: "factory-ship", group: "Factory", title: "Factory: ship (pull requests, deploys, releases)", icon: <GitPullRequest />, keywords: "pr merge deploy release environments", run: () => openFactory("ship") },
    { id: "factory-releases", group: "Factory", title: "Factory: releases", icon: <Tag />, keywords: "release changelog version tag publish draft notes semver bump", run: () => openFactory("releases") },
    { id: "factory-practices",group: "Factory", title: "Factory: practices", icon: <ShieldCheck />, keywords: "practice packs rules maintainability kiss yagni lint agents", run: () => openFactory("practices") },
    { id: "factory-mobile", group: "Factory", title: "Factory: mobile builds", icon: <Smartphone />, keywords: "expo eas ios android testflight store ota", run: () => openFactory("mobile") },
    { id: "factory-signals", group: "Factory", title: "Factory: signals inbox", icon: <Radio />, keywords: "sentry posthog errors triage alerts", run: () => openFactory("signals") },
    { id: "factory-secrets", group: "Factory", title: "Factory: secrets and environments", icon: <KeyRound />, keywords: "env keys values environments vault", run: () => openFactory("secrets") },
    { id: "memory", group: "Memory", title: "Open project memory", icon: <Brain />, keywords: "rules conventions agents.md claude.md", run: () => void ui.openTab({ kind: "memory", title: "Memory" }) },
    { id: "roadmap-new", group: "Roadmap", title: "New roadmap item…", icon: <Kanban />, keywords: "add roadmap idea", run: () => { ui.openTab({ kind: "roadmap", title: "Roadmap" }); setTimeout(() => bus.emit("roadmap-new-item"), 160); } },
    { id: "past-sessions", group: "Agent", title: "Search past sessions…", icon: <History />, keywords: "history transcript replay find conversation export", run: () => { ui.setActivity("sessions"); setTimeout(() => bus.emit("sessions-search"), 60); } },
    { id: "docs", group: "Docs", title: "Show docs", icon: <BookText />, keywords: "documentation pages architecture adr", run: () => ui.setActivity("docs") },
    { id: "docs-new", group: "Docs", title: "New doc page…", icon: <FilePlus2 />, keywords: "documentation write", run: () => { ui.setActivity("docs"); setTimeout(() => bus.emit("docs-new-page"), 60); } },
    { id: "docs-adr", group: "Docs", title: "New decision record…", icon: <Gavel />, keywords: "adr architecture decision", run: () => { ui.setActivity("docs"); setTimeout(() => bus.emit("docs-new-adr"), 60); } },
    { id: "docs-generate", group: "Docs", title: "Write documentation with an agent…", icon: <Sparkles />, keywords: "generate refresh overview architecture runbook", run: () => { ui.setActivity("docs"); setTimeout(() => bus.emit("docs-generate"), 60); } },
    { id: "toggle-left", group: "View", title: "Toggle sidebar", icon: <PanelLeft />, shortcut: formatCombo({ key: "b", mod: true }), run: ui.toggleLeft },
    { id: "toggle-right", group: "View", title: "Toggle agent panel", icon: <PanelRight />, run: ui.toggleRight },
    { id: "toggle-bottom", group: "View", title: "Toggle terminal panel", icon: <PanelBottom />, shortcut: "Ctrl+`", run: ui.toggleBottom },
    { id: "terminal", group: "Terminal", title: "Focus terminal", icon: <SquareTerminal />, run: () => ui.setBottomTab("terminal") },
    { id: "heads", group: "Agent", title: "Show heads", icon: <Bot />, run: () => ui.setRightTab("heads") },
    ...THEME_OPTIONS.map((o) => ({ id: `theme-${o.value}`, group: "View", title: `Theme: ${o.label}`, icon: <Palette />, keywords: "appearance dark light mono graphite catppuccin spritecraft pixel retro", run: () => ui.setTheme(o.value) })),
    { id: "toggle-glass", group: "View", title: ui.glass ? "Translucent sidebar: turn off" : "Translucent sidebar: turn on", icon: <Palette />, keywords: "glass vibrancy blur frosted transparent acrylic", when: glassSupported, run: () => ui.setGlass(!ui.glass) },
    { id: "close-tab", group: "Editor", title: "Close tab", icon: <X />, shortcut: "Alt+W", when: () => !!ws.activeTab, run: () => { if (ws.activeTab) void closeTabGuarded(ws.activeTab); } },
    { id: "close-all", group: "Editor", title: "Close all tabs", icon: <X />, when: () => ws.tabs.length > 0, run: () => void closeManyGuarded(ws.tabs.map((t) => t.id)) },
    { id: "set-pairs", group: "Settings", title: "Hydra pairs", icon: <Settings2 />, run: () => void ui.openTab({ kind: "settings", page: "pairs", title: "Hydra pairs" }) },
    { id: "set-mcp", group: "Settings", title: "MCP servers", icon: <Settings2 />, run: () => void ui.openTab({ kind: "settings", page: "mcp", title: "MCP servers" }) },
    { id: "set-skills", group: "Settings", title: "Skills", icon: <Settings2 />, run: () => void ui.openTab({ kind: "settings", page: "skills", title: "Skills" }) },
    { id: "set-engines", group: "Settings", title: "Engines", icon: <Settings2 />, run: () => void ui.openTab({ kind: "settings", page: "engines", title: "Engines" }) },
    { id: "set-config", group: "Settings", title: "Daemon settings", icon: <Settings2 />, run: () => void ui.openTab({ kind: "settings", page: "config", title: "Settings" }) },
    { id: "home", group: "Go", title: "Switch workspace…", icon: <FolderOpen />, run: () => navigate("/") },
  ];
  useRegisterCommands("shell", cmds, [ws.activeTab, ws.tabs.length]);
}
