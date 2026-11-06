import { lazy, memo, Suspense } from "react";
import { ChevronDown } from "lucide-react";
import { useUi } from "@/lib/store";
import { IconButton } from "@/components/ui/button";
const TerminalPanel = lazy(() => import("@/features/terminal/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));

/** The terminal dock. The panel owns its own tab strip (one tab per terminal); this adds the dock controls. */
export const BottomPanel = memo(function BottomPanel() {
  const toggleBottom = useUi((s) => s.toggleBottom);
  return (
    <div className="relative h-full">
      <IconButton label="Hide panel" shortcut="Ctrl+`" size="icon-sm" onClick={toggleBottom} className="absolute right-1.5 top-1 z-10">
        <ChevronDown />
      </IconButton>
      <Suspense fallback={null}>
        <TerminalPanel />
      </Suspense>
    </div>
  );
});
