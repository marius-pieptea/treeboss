import { useEffect, useRef } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { useUi } from "@/lib/store";
import { loadLanguage } from "./language";
import { trbTheme } from "./theme";

/** Side by side: the file on disk (left) against the editor's buffer (right). Read-only; a way to decide, not to edit. */
export function Compare({ disk, mine, lang, onClose }: { disk: string; mine: string; lang: string; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const dark = useUi((s) => s.theme === "dark");
  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    let mv: MergeView | null = null;
    // Load the grammar first so the view is built once, already highlighted.
    loadLanguage(lang).then((l) => {
      if (!alive || !host.current) return;
      const ext = [EditorState.readOnly.of(true), EditorView.editable.of(false), trbTheme(dark), EditorView.lineWrapping, ...(l ? [l] : [])];
      mv = new MergeView({ a: { doc: disk, extensions: ext }, b: { doc: mine, extensions: ext }, parent: host.current, highlightChanges: true, gutter: true, collapseUnchanged: { margin: 3, minSize: 6 } });
    });
    return () => {
      alive = false;
      mv?.destroy();
    };
  }, [disk, mine, lang, dark]);

  return (
    <div className="absolute inset-0 z-20 flex animate-in flex-col bg-panel fade-in-0 duration-150">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3 text-xs">
        <div className="flex items-center gap-4 text-fg-muted">
          <span>
            <span className="mr-1.5 inline-block size-2 rounded-sm bg-red/70 align-middle" />
            On disk
          </span>
          <span>
            <span className="mr-1.5 inline-block size-2 rounded-sm bg-green/70 align-middle" />
            Your edits
          </span>
        </div>
        <IconButton label="Close comparison" size="icon-sm" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div ref={host} className="min-h-0 flex-1 overflow-auto [&_.cm-mergeView]:h-full [&_.cm-mergeViewEditors]:min-h-full" />
    </div>
  );
}
