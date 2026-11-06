import { Bot, Globe } from "lucide-react";
import { useUi, type Tab } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AGENT_URL } from "./agent-logic";
import { titleFor } from "./logic";

/** The address a tab had in preview mode, so switching to the agent browser and back does not lose it. */
const lastPreview = new Map<string, string>();

/** Preview | Agent: one browser tab, two ways of looking. The mode is the tab's address (a sentinel for the agent view). */
export function ModeSwitch({ tab, mode, className }: { tab: Extract<Tab, { kind: "browser" }>; mode: "preview" | "agent"; className?: string }) {
  const updateTab = useUi((s) => s.updateTab);
  const choose = (next: "preview" | "agent") => {
    if (next === mode) return;
    if (next === "agent") {
      lastPreview.set(tab.id, tab.url);
      updateTab(tab.id, { url: AGENT_URL, title: "Agent browser" });
    } else {
      const back = lastPreview.get(tab.id) ?? "";
      updateTab(tab.id, { url: back, title: back ? titleFor(back) : "Preview" });
    }
  };
  const item = (id: "preview" | "agent", label: string, icon: React.ReactNode) => (
    <button
      role="tab"
      aria-selected={mode === id}
      onClick={() => choose(id)}
      className={cn("flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium outline-none transition-colors [&_svg]:size-3", mode === id ? "bg-panel text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg")}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Browser mode" className={cn("flex shrink-0 items-center gap-0.5 rounded-lg bg-raised p-0.5", className)}>
      {item("preview", "Preview", <Globe />)}
      {item("agent", "Agent", <Bot />)}
    </div>
  );
}
