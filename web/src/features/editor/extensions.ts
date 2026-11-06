/** Small CodeMirror extensions the editor composes: change gutter, indent guides, line flash. */
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { getIndentUnit } from "@codemirror/language";
import type { ChangeKind, ChangeMarker } from "./hunks";

/* ----------------------------------------------------------------- change gutter */

class ChangeGutterMarker extends GutterMarker {
  constructor(readonly kind: ChangeKind) {
    super();
  }
  eq(other: GutterMarker): boolean {
    return other instanceof ChangeGutterMarker && other.kind === this.kind;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-git cm-git-${this.kind}`;
    return el;
  }
}
const MARKERS: Record<ChangeKind, ChangeGutterMarker> = { add: new ChangeGutterMarker("add"), mod: new ChangeGutterMarker("mod"), del: new ChangeGutterMarker("del") };

export const setChangeMarkers = StateEffect.define<ChangeMarker[]>();

function build(doc: Text, markers: ChangeMarker[]): RangeSet<GutterMarker> {
  const lines = new Map<number, ChangeKind>();
  for (const m of markers) {
    if (m.kind === "del") {
      // The deletion sits between lines: mark the line below it (or the last line for a tail deletion).
      const at = Math.min(Math.max(m.from + 1, 1), doc.lines);
      if (!lines.has(at)) lines.set(at, "del");
      continue;
    }
    for (let n = Math.max(1, m.from); n <= Math.min(m.to, doc.lines); n++) lines.set(n, m.kind);
  }
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const n of [...lines.keys()].sort((a, b) => a - b)) builder.add(doc.line(n).from, doc.line(n).from, MARKERS[lines.get(n)!]);
  return builder.finish();
}

const changeField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setChangeMarkers)) return build(tr.state.doc, e.value);
    // Typing above a marker shifts it; the gutter follows without waiting for the next diff.
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

export const changeGutter: Extension = [changeField, gutter({ class: "cm-git-gutter", markers: (v) => v.state.field(changeField), initialSpacer: () => MARKERS.add })];

/* ------------------------------------------------------------------ indent guides */

/**
 * Faint vertical rules at each indentation level, drawn as a background on the line itself (no extra DOM,
 * so it costs nothing on a long file). Width is in `ch`, which tracks the monospace font.
 */
export const indentGuides: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.compute(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.length) this.decorations = this.compute(u.view);
    }
    compute(view: EditorView): DecorationSet {
      const unit = getIndentUnit(view.state);
      const tab = view.state.tabSize;
      const b = new RangeSetBuilder<Decoration>();
      let last = -1;
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          pos = line.to + 1;
          if (line.from === last) continue;
          last = line.from;
          let cols = 0;
          for (let i = 0; i < line.text.length; i++) {
            const c = line.text[i];
            if (c === " ") cols++;
            else if (c === "\t") cols += tab;
            else break;
          }
          const step = Math.max(unit, 1);
          const levels = Math.floor(cols / step);
          if (levels < 1) continue;
          b.add(
            line.from,
            line.from,
            Decoration.line({
              attributes: {
                class: "cm-indent-guides",
                style: `background-image:repeating-linear-gradient(to right,var(--line) 0,var(--line) 1px,transparent 1px,transparent ${step}ch);background-size:${levels * step}ch 100%;background-position:6px 0`,
              },
            }),
          );
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

/* ------------------------------------------------------------------- line flash */

const flashEffect = StateEffect.define<number[]>();
const clearFlash = StateEffect.define<null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearFlash)) value = Decoration.none;
      if (e.is(flashEffect)) {
        const b = new RangeSetBuilder<Decoration>();
        for (const n of [...new Set(e.value)].sort((a, b2) => a - b2)) if (n >= 1 && n <= tr.state.doc.lines) b.add(tr.state.doc.line(n).from, tr.state.doc.line(n).from, Decoration.line({ class: "cm-flash-line" }));
        value = b.finish();
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
export const flashExtension: Extension = flashField;

/** Briefly highlight lines (a jump target, an externally changed region). */
export function flashLines(view: EditorView, lines: number[], ms = 1400): void {
  view.dispatch({ effects: flashEffect.of(lines) });
  setTimeout(() => {
    if ((view as unknown as { destroyed?: boolean }).destroyed) return;
    try {
      view.dispatch({ effects: clearFlash.of(null) });
    } catch {
      /* the view went away mid-flash */
    }
  }, ms);
}
