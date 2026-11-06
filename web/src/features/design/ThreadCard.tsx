import { useEffect, useRef, useState } from "react";
import { Columns3, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUi } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { useDesign } from "./data";

/** The width the directions page is laid out at before it is scaled down into the thread. */
const PAGE_WIDTH = 1280;
const PAGE_HEIGHT = 560;

/**
 * In a design thread: the directions a brainstorm wrote, as a scaled-down preview with a way to compare
 * them full size in the Design tab. Agent-written HTML, so the frame is fully sandboxed (no scripts, an
 * opaque origin). Nothing shows until design/directions.html exists, and it goes once the agent deletes it.
 */
export function DesignThreadCard() {
  const { root } = useWorkspace();
  const q = useDesign(root);
  const openTab = useUi((s) => s.openTab);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / PAGE_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, [q.data?.directions.exists]);

  const d = q.data?.directions;
  if (!d?.exists) return null;
  return (
    <section data-design-thread-card className="overflow-hidden rounded-xl border border-accent/40 animate-slide-up">
      <div className="flex items-center gap-2 border-b border-line bg-accent-soft/60 px-3 py-2">
        <Columns3 className="size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold">Directions to choose from</div>
          <div className="text-[11px] leading-snug text-fg-muted">Reply with a letter and any changes, like “B, but warmer”.</div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => openTab({ kind: "design", title: "Design" })} data-design-compare>
          <Maximize2 /> Compare
        </Button>
      </div>
      {d.html !== null ? (
        <div ref={box} className="relative w-full overflow-hidden bg-white" style={{ height: PAGE_HEIGHT * scale }}>
          <iframe title="Design directions preview" sandbox="" srcDoc={d.html} tabIndex={-1} aria-hidden className="pointer-events-none absolute left-0 top-0 origin-top-left border-0" style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: `scale(${scale})` }} />
        </div>
      ) : (
        <p className="p-3 text-[12px] text-fg-muted">The page is too large to preview here. Compare it in the Design tab.</p>
      )}
    </section>
  );
}
