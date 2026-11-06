import { Badge } from "@/components/ui/misc";
import { Switch } from "@/components/ui/form";
import { useCodegraphGlobal, useCodegraphToggle } from "./data";

/** Settings > MCP: CodeGraph as a built-in, like `trb`. Not editable, only switchable. */
export function CodegraphMcpRow() {
  const q = useCodegraphGlobal();
  const toggle = useCodegraphToggle();
  if (!q.data?.available) return null;
  return (
    <div className="rounded-xl border border-line bg-raised/40 p-3.5 animate-slide-up">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[13px] font-semibold">codegraph</span>
        <Badge tone="accent">built in</Badge>
        <span className="min-w-0 flex-1 text-xs text-fg-muted">Added to sessions in projects that already have a .codegraph/ index. Agents can leave it out by not listing it.</span>
        <Switch checked={q.data.setting === "auto"} onChange={(v) => toggle.mutate(v)} label="Use CodeGraph in sessions" />
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {["codegraph_explore", "codegraph_node"].map((t) => (
          <span key={t} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
