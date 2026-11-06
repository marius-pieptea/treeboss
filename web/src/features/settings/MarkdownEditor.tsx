import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { searchKeymap } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

/** Editor chrome from the app's own tokens, so it follows the theme with no second palette to maintain. */
const theme = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "transparent", fontSize: "12.5px" },
  ".cm-content": { caretColor: "var(--accent)", padding: "12px 0" },
  ".cm-line": { padding: "0 16px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--accent) 28%, transparent)" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-placeholder": { color: "var(--fg-faint)" },
  ".cm-panels": { backgroundColor: "var(--overlay)", color: "var(--fg)", borderColor: "var(--line)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--amber) 30%, transparent)" },
});

const highlight = HighlightStyle.define([
  { tag: t.heading1, color: "var(--accent)", fontWeight: "700", fontSize: "1.15em" },
  { tag: [t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: "var(--accent)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "var(--blue)" },
  { tag: t.url, color: "var(--blue)", textDecoration: "underline" },
  { tag: [t.monospace, t.processingInstruction], color: "var(--violet)" },
  { tag: t.quote, color: "var(--fg-muted)", fontStyle: "italic" },
  { tag: [t.list, t.meta, t.contentSeparator], color: "var(--amber)" },
  { tag: t.comment, color: "var(--fg-faint)" },
]);

/** A markdown editor: the one place the settings pages need free-form text with structure (SKILL.md). */
export function MarkdownEditor({ value, onChange, onSave, readOnly, label }: { value: string; onChange: (text: string) => void; onSave?: () => void; readOnly?: boolean; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown(),
          theme,
          syntaxHighlighting(highlight),
          placeholder("Write the instructions the agent should follow."),
          EditorState.readOnly.of(!!readOnly),
          EditorView.contentAttributes.of({ "aria-label": label }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave?.(), true) },
            indentWithTab,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The document is owned by the editor once mounted; the parent re-keys it to load a different one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  return <div ref={host} className="h-full min-h-0 overflow-auto" />;
}
