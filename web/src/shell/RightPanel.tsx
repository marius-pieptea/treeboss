import { memo } from "react";
import { Bot, Network } from "lucide-react";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PaneBoundary } from "@/components/PaneBoundary";
import { AgentPanel } from "@/features/agent/AgentPanel";
import { HeadsPanel } from "@/features/heads/HeadsPanel";

export const RightPanel = memo(function RightPanel({ headCount, runningHeads }: { headCount: number; runningHeads: number }) {
  const rightTab = useUi((s) => s.rightTab);
  const setRightTab = useUi((s) => s.setRightTab);
  const tab = (id: "agent" | "heads", label: string, icon: React.ReactNode, badge?: React.ReactNode) => (
    <button key={id} onClick={() => setRightTab(id)} role="tab" aria-selected={rightTab === id} className={cn("relative flex h-full items-center gap-1.5 px-3 text-[12.5px] font-medium outline-none transition-colors [&_svg]:size-3.5", rightTab === id ? "text-fg" : "text-fg-muted hover:text-fg")}>
      {icon}
      {label}
      {badge}
      <span className={cn("absolute inset-x-2 bottom-0 h-px origin-center bg-accent transition-transform duration-200", rightTab === id ? "scale-x-100" : "scale-x-0")} />
    </button>
  );
  return (
    <div className="flex h-full flex-col">
      <div role="tablist" className="flex h-9 shrink-0 items-stretch border-b border-line bg-bg">
        {tab("agent", "Agent", <Bot />)}
        {tab(
          "heads",
          "Heads",
          <Network />,
          headCount > 0 ? <span className={cn("rounded px-1 font-mono text-[10px]", runningHeads > 0 ? "bg-accent-soft text-accent" : "bg-raised text-fg-faint")}>{headCount}</span> : null,
        )}
      </div>
      <div className="min-h-0 flex-1">{rightTab === "agent" ? (
          <PaneBoundary name="Agent">
            <AgentPanel />
          </PaneBoundary>
        ) : (
          <PaneBoundary name="Heads">
            <HeadsPanel />
          </PaneBoundary>
        )}</div>
    </div>
  );
});
