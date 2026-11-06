/**
 * The editor theme, built entirely from the app's CSS variables: switching the app theme restyles the
 * editor with no rebuild. `dark` only tells CodeMirror which of its own built-in defaults (cursor, selection
 * layers) to use.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--violet)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted], color: "var(--green)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.changed], color: "var(--amber)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--fg-faint)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--blue)" },
  { tag: [t.className, t.typeName, t.namespace, t.standard(t.typeName)], color: "var(--accent)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--fg)" },
  { tag: [t.propertyName, t.variableName], color: "var(--fg)" },
  { tag: [t.special(t.variableName), t.self, t.labelName], color: "var(--red)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], color: "var(--fg-muted)" },
  { tag: [t.tagName], color: "var(--red)" },
  { tag: [t.attributeName], color: "var(--amber)" },
  { tag: [t.attributeValue], color: "var(--green)" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: "var(--fg)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--accent)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.quote, color: "var(--fg-muted)" },
  { tag: [t.monospace, t.processingInstruction], color: "var(--accent)" },
  { tag: [t.meta, t.documentMeta, t.annotation], color: "var(--fg-faint)" },
  { tag: t.deleted, color: "var(--red)" },
  { tag: t.invalid, color: "var(--red)", textDecoration: "underline wavy" },
]);

const field = { background: "var(--raised)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "5px" };

export function trbTheme(dark: boolean): Extension {
  return [
    EditorView.theme(
      {
        "&": { color: "var(--fg)", backgroundColor: "transparent", fontSize: "12.5px", height: "100%" },
        ".cm-scroller": { overflow: "auto" },
        ".cm-content": { caretColor: "var(--accent)", padding: "6px 0 40px" },
        ".cm-line": { padding: "0 8px 0 6px" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { background: "color-mix(in oklab, var(--accent) 26%, transparent) !important" },
        ".cm-activeLine": { backgroundColor: "var(--hover)" },
        ".cm-selectionMatch": { backgroundColor: "color-mix(in oklab, var(--amber) 24%, transparent)", borderRadius: "2px" },
        ".cm-gutters": { backgroundColor: "transparent", color: "var(--fg-faint)", border: "none", paddingLeft: "2px" },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 4px", minWidth: "3.2ch", fontSize: "11.5px" },
        ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg)" },
        ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", padding: "0 3px", opacity: "0", transition: "opacity .12s" },
        ".cm-gutters:hover .cm-foldGutter .cm-gutterElement, .cm-foldGutter .cm-gutterElement:has(span[title='Unfold line'])": { opacity: "1" },
        ".cm-foldPlaceholder": { backgroundColor: "var(--raised)", border: "1px solid var(--line)", color: "var(--fg-muted)", borderRadius: "4px", padding: "0 5px", margin: "0 2px" },
        ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "1px solid color-mix(in oklab, var(--accent) 45%, transparent)", color: "inherit !important" },
        ".cm-nonmatchingBracket": { backgroundColor: "color-mix(in oklab, var(--red) 25%, transparent)" },
        ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--amber) 28%, transparent)", outline: "1px solid color-mix(in oklab, var(--amber) 50%, transparent)", borderRadius: "2px" },
        ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--accent) 38%, transparent)", outlineColor: "var(--accent)" },
        ".cm-flash-line": { animation: "trb-flash 1.3s ease-out both" },

        // Git change gutter.
        ".cm-git-gutter": { width: "4px", marginRight: "2px" },
        ".cm-git-gutter .cm-gutterElement": { padding: "0" },
        ".cm-git": { width: "3px", height: "100%", borderRadius: "1px" },
        ".cm-git-add": { background: "var(--green)" },
        ".cm-git-mod": { background: "var(--amber)" },
        ".cm-git-del": { height: "0", width: "0", marginTop: "-1px", borderLeft: "3px solid var(--red)", borderTop: "3px solid transparent", borderBottom: "3px solid transparent", background: "none" },

        // Panels (search / go to line) styled like the app's own fields.
        ".cm-panels": { backgroundColor: "var(--raised)", color: "var(--fg)", borderColor: "var(--line)" },
        ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
        ".cm-panel.cm-search": { padding: "6px 30px 6px 8px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 6px", fontSize: "12px" },
        ".cm-panel.cm-search br": { display: "none" },
        ".cm-panel.cm-search input, .cm-panel.cm-gotoLine input": { ...field, padding: "3px 7px", margin: "0", outline: "none", fontSize: "12px", fontFamily: "var(--font-code)" },
        ".cm-panel.cm-search input:focus, .cm-panel.cm-gotoLine input:focus": { borderColor: "var(--accent)" },
        ".cm-panel.cm-search input[type=checkbox]": { accentColor: "var(--accent)" },
        ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--fg-muted)", fontSize: "11.5px" },
        ".cm-panel.cm-search button, .cm-panel.cm-gotoLine button": { ...field, padding: "3px 9px", fontSize: "11.5px", cursor: "pointer", backgroundImage: "none" },
        ".cm-panel.cm-search button:hover, .cm-panel.cm-gotoLine button:hover": { background: "var(--active)" },
        ".cm-panel.cm-search [name=close]": { position: "absolute", top: "5px", right: "6px", background: "none", border: "none", color: "var(--fg-muted)", fontSize: "16px", padding: "0 4px" },
        ".cm-panel.cm-gotoLine": { padding: "6px 8px", display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" },

        ".cm-tooltip": { ...field, background: "var(--overlay)", boxShadow: "var(--shadow)", borderRadius: "8px", overflow: "hidden" },
        ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-code)", fontSize: "12px", maxHeight: "16em" },
        ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
        ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--active)", color: "var(--fg)" },
        ".cm-completionIcon": { opacity: "0.6" },

        ".cm-indent-guides": { backgroundRepeat: "no-repeat" },
      },
      { dark },
    ),
    syntaxHighlighting(highlight),
  ];
}
