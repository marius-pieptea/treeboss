import { BookOpen, FileDown, FolderPlus, Layers, ListChecks, Plus, Server, Smartphone, Stethoscope, UserRoundCog } from "lucide-react";
import { useCommandStore, type Command } from "@/lib/commands";
import { queryClient } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { keys } from "./data";
import { useSettingsUi, type SettingsDialog } from "./ui-state";

type Page = "agents" | "pairs" | "mcp" | "skills" | "engines" | "config" | "workspace" | "remote" | "verify" | "practices" | "templates" | "design-systems" | "checklists";
const TITLES: Record<Page, string> = { agents: "Agents", pairs: "Hydra pairs", mcp: "MCP servers", skills: "Skills", engines: "Engines", config: "Settings", workspace: "Workspace", remote: "Remote access", verify: "Verification", practices: "Practices", templates: "Templates", "design-systems": "Design systems", checklists: "Checklists" };

export function openSettingsPage(page: Page): void {
  useUi.getState().openTab({ kind: "settings", page, title: TITLES[page] });
}

function withDialog(page: Page, dialog: Exclude<SettingsDialog, null>): () => void {
  return () => {
    openSettingsPage(page);
    useSettingsUi.getState().open(dialog);
  };
}

const commands: Command[] = [
  { id: "settings-new-agent", group: "Settings", title: "New agent…", icon: <UserRoundCog />, keywords: "specialized instructions persona skills", run: withDialog("agents", "agent-new") },
  { id: "settings-workspace", group: "Settings", title: "Workspace folders (plans, docs, roadmap)", icon: <Layers />, keywords: "plans docs roadmap folder path", run: () => openSettingsPage("workspace") },
  { id: "settings-templates", group: "Settings", title: "Templates: edit New app recipes", icon: <Layers />, keywords: "scaffold recipe new app generator starter", run: () => openSettingsPage("templates") },
  { id: "settings-design-systems", group: "Settings", title: "Design systems: edit the library", icon: <Layers />, keywords: "design.md tokens theme brand new app", run: () => openSettingsPage("design-systems") },
  { id: "settings-checklists", group: "Settings", title: "Checklists: edit the launch checklists", icon: <ListChecks />, keywords: "launch checklist audit item deploy gate", run: () => openSettingsPage("checklists") },
  { id: "settings-practices", group: "Settings", title: "Practices: edit rules and checks for agents", icon: <ListChecks />, keywords: "practice pack rule check lint agent standard", run: () => openSettingsPage("practices") },
  { id: "settings-remote", group: "Settings", title: "Remote access: pair a phone…", icon: <Smartphone />, keywords: "mobile qr pair phone lan tailscale", run: () => openSettingsPage("remote") },
  { id: "settings-agents", group: "Settings", title: "Agents", icon: <UserRoundCog />, keywords: "specialized instructions persona", run: () => openSettingsPage("agents") },
  { id: "settings-add-mcp", group: "Settings", title: "Add MCP server…", icon: <Server />, keywords: "tools context7 playwright", run: withDialog("mcp", "mcp-add") },
  { id: "settings-import-mcp", group: "Settings", title: "Import MCP servers from Claude…", icon: <FileDown />, run: withDialog("mcp", "mcp-import") },
  { id: "settings-new-skill", group: "Settings", title: "New skill…", icon: <Plus />, run: withDialog("skills", "skill-new") },
  { id: "settings-add-skill", group: "Settings", title: "Add skill from folder…", icon: <FolderPlus />, run: withDialog("skills", "skill-add") },
  { id: "settings-import-skills", group: "Settings", title: "Import skills from a directory…", icon: <BookOpen />, run: withDialog("skills", "skill-import") },
  { id: "settings-new-pair", group: "Settings", title: "New Hydra pair…", icon: <Layers />, keywords: "lead heads roles", run: withDialog("pairs", "pair-new") },
  {
    id: "settings-doctor",
    group: "Settings",
    title: "Run doctor (check engines and tools)",
    icon: <Stethoscope />,
    keywords: "diagnose health",
    run: () => {
      openSettingsPage("engines");
      void queryClient.invalidateQueries({ queryKey: keys.doctor });
    },
  },
];

/**
 * Registered when this module loads (the shell imports the settings sidebar at startup), not while a
 * settings component is mounted: "Add MCP server…" must be in the palette when no settings page is open.
 */
export function registerSettingsCommands(): void {
  useCommandStore.getState().set("settings", commands);
}
