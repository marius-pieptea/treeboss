/**
 * The CodeMirror editor for one file tab.
 *
 * The view is created on mount and destroyed on unmount, but its STATE (document, undo history, cursor,
 * scroll) is stashed by tab id (buffers.ts) and restored, so switching tabs costs nothing and closing a tab
 * with unsaved edits does not lose them. Anything in the state that closes over component state (the update
 * listener, the key bindings) lives in a Compartment that is reconfigured on every mount: a restored state
 * would otherwise still call into the previous, unmounted component.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, get, url } from "@/lib/api";
import { bus } from "@/lib/bus";
import { useRoot, useGitStatus } from "@/lib/queries";
import { useUi, type Tab } from "@/lib/store";
import { fsToGitPath } from "@/lib/workspace";
import type { FileRead } from "@/lib/types";
import { confirm } from "@/components/ui/dialogs";
import { MarkdownPreview, SvgPreview } from "./MarkdownPreview";
import { Compare } from "./Compare";
import { BannerStrip, Breadcrumb, StatusStrip, type Banner, type StatusInfo } from "./EditorChrome";
import { bufferStore, editorFocus, isDirty, liveEditors, writeDoc, type BufferMeta } from "./buffers";
import { changedLineRange } from "./diffRange";
import { changeGutter, flashExtension, flashLines, indentGuides, setChangeMarkers } from "./extensions";
import { hunksToMarkers, wholeFileAdded } from "./hunks";
import { detectIndent } from "./indent";
import { detectLanguage, loadLanguage, previewKind } from "./language";
import { useEditorPrefs } from "./prefs";
import { trbTheme } from "./theme";

type FileTabT = Extract<Tab, { kind: "file" }>;
type TextFile = Extract<FileRead, { content: string }>;

// Module-level on purpose: a restored EditorState carries the compartment objects it was built with.
const C = { theme: new Compartment(), lang: new Compartment(), wrap: new Compartment(), indent: new Compartment(), guides: new Compartment(), listener: new Compartment(), keys: new Compartment() };

const foldMarker = (open: boolean): HTMLElement => {
  const el = document.createElement("span");
  el.title = open ? "Fold line" : "Unfold line";
  el.textContent = open ? "⌄" : "›";
  el.style.cssText = "color:var(--fg-faint);font-size:13px;line-height:1;display:inline-block;width:10px;text-align:center";
  return el;
};

/** How long typing must pause before an autosave fires. */
const AUTOSAVE_DELAY_MS = 1000;

function baseExtensions(): Extension[] {
  return [
    C.keys.of([]),
    lineNumbers(),
    highlightActiveLineGutter(),
    changeGutter,
    foldGutter({ markerDOM: foldMarker }),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(4),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    flashExtension,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
    C.theme.of(trbTheme(true)),
    C.lang.of([]),
    C.wrap.of([]),
    C.indent.of([]),
    C.guides.of([]),
    C.listener.of([]),
  ];
}

const indentExt = (unit: string): Extension => indentUnit.of(unit);

function statusOf(state: EditorState): StatusInfo {
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  let selected = 0;
  for (const r of state.selection.ranges) selected += r.to - r.from;
  return { line: line.number, col: sel.head - line.from + 1, selected, ranges: state.selection.ranges.length, lines: state.doc.lines };
}

export function CodeEditor({ tab, file, deleted }: { tab: FileTabT; file: TextFile | null; deleted: boolean }) {
  const { root, path } = tab;
  const qc = useQueryClient();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const metaRef = useRef<BufferMeta | null>(null);
  const prefs = useEditorPrefs();
  const dark = useUi((s) => s.theme === "dark");
  const setDirty = useUi((s) => s.setDirty);
  const closeTab = useUi((s) => s.closeTab);
  const setActivity = useUi((s) => s.setActivity);
  const lang = useMemo(() => detectLanguage(path), [path]);
  const preview = previewKind(path);

  const [status, setStatus] = useState<StatusInfo>({ line: 1, col: 1, selected: 0, ranges: 1, lines: 1 });
  const [dirty, setDirtyLocal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [compare, setCompare] = useState<{ disk: string; mine: string } | null>(null);
  const [mode, setModeState] = useState<"edit" | "preview">("edit");
  const [previewText, setPreviewText] = useState("");
  const [eol, setEolState] = useState<"lf" | "crlf">(file?.eol ?? "lf");
  const [indentLabel, setIndentLabel] = useState("Spaces: 2");
  const [flash, setFlash] = useState(0);
  /** Bumped once the view exists, so effects that need it (the change gutter) run after it is built. */
  const [mounted, setMounted] = useState(0);

  const callbacks = useRef({ save: async (_expected?: number): Promise<boolean> => false });

  /* ---- git change gutter ---- */
  const repo = useRoot(root).data?.repo;
  const gitStatus = useGitStatus(root);
  const gitPath = fsToGitPath(path, repo?.prefix);
  const entry = gitStatus.data?.files.find((f) => f.path === gitPath);
  const entrySig = entry ? `${entry.index}${entry.worktree}` : "";
  const gutterQuery = useQuery({
    queryKey: ["git", root, "gutter", path, entrySig],
    enabled: Boolean(repo?.isRepo) && Boolean(entry) && entry?.worktree !== "?",
    queryFn: async () => {
      // Unstaged edits are shown against the index; a change that is only staged is shown against HEAD.
      const staged = entry!.worktree === "." || entry!.worktree === "D";
      const r = await get<{ diff: string }>(url.git(root, "diff", { path, context: 0, staged }));
      return hunksToMarkers(r.diff);
    },
    staleTime: 800,
  });

  const untracked = entry?.worktree === "?";
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let markers = gutterQuery.data;
    if (untracked) markers = wholeFileAdded(view.state.doc.lines);
    if (!entry) markers = [];
    if (markers) view.dispatch({ effects: setChangeMarkers.of(markers) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gutterQuery.data, untracked, entrySig, mounted, untracked ? status.lines : 0]);

  /* ---- reporting ---- */
  const report = useCallback(() => {
    const view = viewRef.current;
    const meta = metaRef.current;
    if (!view || !meta) return;
    const d = isDirty({ state: view.state, meta });
    setDirtyLocal(d);
    setDirty(tab.id, d);
  }, [setDirty, tab.id]);

  const replaceDoc = useCallback(
    (text: string, opts: { history: boolean; flashChange: boolean }) => {
      const view = viewRef.current;
      if (!view) return;
      const before = view.state.doc.toString();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: opts.history ? [] : [Transaction.addToHistory.of(false)] });
      if (opts.flashChange) {
        const r = changedLineRange(before, view.state.doc.toString());
        if (r) flashLines(view, Array.from({ length: Math.min(r.to - r.from + 1, 400) }, (_, i) => r.from + i));
        setFlash((n) => n + 1);
      }
    },
    [],
  );

  const goto = useCallback((line: number, column?: number) => {
    const view = viewRef.current;
    if (!view) return;
    const n = Math.min(Math.max(1, line), view.state.doc.lines);
    const l = view.state.doc.line(n);
    const pos = Math.min(l.from + Math.max((column ?? 1) - 1, 0), l.to);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    flashLines(view, [n]);
    // Take focus only when nothing else is in use: a jump from the search results list must not steal it.
    const ae = document.activeElement;
    const idle = !ae || ae === document.body || host.current?.contains(ae);
    const busy = ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || Boolean(ae?.closest('[role="tree"]'));
    if (editorFocus.take() || (idle && !busy)) view.focus();
  }, []);

  /* ---- save and friends ---- */
  const doSave = useCallback(
    async (expectedOverride?: number): Promise<boolean> => {
      const view = viewRef.current;
      const meta = metaRef.current;
      if (!view || !meta) return false;
      const doc = view.state.doc;
      const e = meta.eol;
      setSaving(true);
      try {
        const r = await writeDoc(root, path, doc, e, expectedOverride ?? meta.savedMtime);
        meta.savedDoc = doc;
        meta.savedMtime = r.mtime;
        meta.savedEol = e;
        report();
        setBanner(null);
        setSavedAt(Date.now());
        qc.invalidateQueries({ queryKey: ["git", root, "gutter", path] });
        return true;
      } catch (err: any) {
        if (err instanceof ApiError && err.status === 409) {
          setBanner({ kind: "conflict", diskMtime: err.body?.mtime });
          return false;
        }
        toast.error(`Could not save ${path}`, { description: err?.message });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [root, path, qc, report],
  );
  callbacks.current.save = doSave;

  const loadDisk = useCallback(async (): Promise<TextFile | null> => {
    const r = await get<FileRead>(url.fs(root, "file", { path })).catch(() => null);
    return r && "content" in r ? r : null;
  }, [root, path]);

  const reloadFromDisk = useCallback(async () => {
    const meta = metaRef.current;
    const disk = await loadDisk();
    if (!disk || !meta) return toast.error("Could not read the file from disk");
    replaceDoc(disk.content, { history: true, flashChange: true });
    meta.savedDoc = viewRef.current!.state.doc;
    meta.savedMtime = disk.mtime;
    meta.eol = meta.savedEol = disk.eol;
    setEolState(disk.eol);
    setBanner(null);
    report();
    qc.setQueryData(["fs", root, "file", path], disk);
  }, [loadDisk, replaceDoc, report, qc, root, path]);

  const openCompare = useCallback(async () => {
    const view = viewRef.current;
    const disk = await loadDisk();
    if (!view || !disk) return toast.error("Could not read the file from disk");
    setCompare({ disk: disk.content, mine: view.state.doc.toString() });
  }, [loadDisk]);

  const revert = useCallback(async () => {
    const v = viewRef.current;
    const m = metaRef.current;
    const hasEdits = Boolean(v && m && isDirty({ state: v.state, meta: m }));
    if (hasEdits && !(await confirm({ title: "Revert this file?", description: "Your unsaved changes will be replaced with what is on disk.", confirmLabel: "Revert", danger: true }))) return;
    await reloadFromDisk();
  }, [reloadFromDisk]);

  const toggleWrap = useCallback(() => prefs.setWrap(!prefs.wrap), [prefs]);

  /* ---- mount: build (or restore) the view ---- */
  useEffect(() => {
    if (!host.current) return;
    const stash = bufferStore.get(tab.id);
    let meta: BufferMeta;
    let state: EditorState;
    let restoredDirty = false;
    if (stash) {
      state = stash.state;
      meta = stash.meta;
      // A plain tab switch keeps the tab's dirty flag; only a tab that was closed and reopened has lost it.
      restoredDirty = isDirty(stash) && !useUi.getState().dirty[tab.id];
    } else {
      const content = file?.content ?? "";
      state = EditorState.create({ doc: content, extensions: baseExtensions() });
      meta = { savedDoc: state.doc, savedMtime: file?.mtime ?? 0, eol: file?.eol ?? "lf", savedEol: file?.eol ?? "lf", mode: "edit" };
    }
    metaRef.current = meta;
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

    const indent = detectIndent(view.state.doc.toString());
    setIndentLabel(indent.label);
    setEolState(meta.eol);
    setModeState(meta.mode);
    setStatus(statusOf(view.state));

    view.dispatch({
      effects: [
        C.indent.reconfigure(indentExt(indent.unit)),
        C.listener.reconfigure(
          EditorView.updateListener.of((u) => {
            if (u.docChanged) report();
            // Autosave waits for a pause in typing, then saves whatever the document holds by then.
            if (u.docChanged && useEditorPrefs.getState().autosave) {
              clearTimeout(autosaveTimer);
              autosaveTimer = setTimeout(() => void callbacks.current.save(), AUTOSAVE_DELAY_MS);
            }
            if (u.docChanged || u.selectionSet) setStatus(statusOf(u.state));
          }),
        ),
        C.keys.reconfigure(
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (void callbacks.current.save(), true) },
            { key: "Ctrl-g", run: gotoLine },
            { key: "Alt-z", run: () => (void useEditorPrefs.getState().setWrap(!useEditorPrefs.getState().wrap), true) },
          ]),
        ),
      ],
    });
    if (meta.scroll) view.dispatch({ effects: meta.scroll as any });

    const live = {
      tabId: tab.id,
      root,
      path,
      view,
      meta,
      save: () => callbacks.current.save(),
      revert: () => void revertRef.current(),
      gotoLine: () => {
        gotoLine(view);
        view.focus();
      },
      toggleWrap: () => useEditorPrefs.getState().setWrap(!useEditorPrefs.getState().wrap),
    };
    liveEditors.register(live);
    report();
    setMounted((n) => n + 1);
    if (restoredDirty) setBanner({ kind: "restored" });

    return () => {
      clearTimeout(autosaveTimer);
      liveEditors.unregister(tab.id, live);
      meta.scroll = view.scrollSnapshot() as any;
      if (!bufferStore.consumeDiscard(tab.id)) bufferStore.set(tab.id, { state: view.state, meta, root, path });
      view.destroy();
      viewRef.current = null;
    };
    // The editor is rebuilt only for a different tab; file content updates flow through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  const revertRef = useRef(revert);
  revertRef.current = revert;

  /* ---- reactive configuration ---- */
  useEffect(() => {
    viewRef.current?.dispatch({ effects: C.theme.reconfigure(trbTheme(dark)) });
  }, [dark]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: C.wrap.reconfigure(prefs.wrap ? EditorView.lineWrapping : []) });
  }, [prefs.wrap]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: C.guides.reconfigure(prefs.guides ? indentGuides : []) });
  }, [prefs.guides]);
  useEffect(() => {
    let alive = true;
    loadLanguage(lang.id).then((ext) => alive && viewRef.current?.dispatch({ effects: C.lang.reconfigure(ext ?? []) }));
    return () => {
      alive = false;
    };
  }, [lang.id, tab.id]);

  /* ---- jump to a line ---- */
  useEffect(() => {
    const meta = metaRef.current;
    if (tab.line && meta && meta.appliedLine !== tab.line) {
      meta.appliedLine = tab.line;
      requestAnimationFrame(() => goto(tab.line!));
    }
  }, [tab.line, tab.id, goto]);
  useEffect(() => bus.on("editor-goto", (e) => e.path === path && goto(e.line, e.column)), [path, goto]);

  /* ---- the file changed on disk ---- */
  useEffect(() => {
    const view = viewRef.current;
    const meta = metaRef.current;
    if (!view || !meta) return;
    if (deleted) return setBanner((b) => (b?.kind === "restored" ? b : { kind: "deleted" }));
    setBanner((b) => (b?.kind === "deleted" ? null : b));
    if (!file) return;
    // A response older than our own last save is a refetch that raced it: ignore.
    if (file.mtime <= meta.savedMtime) return;
    const clean = view.state.doc.eq(meta.savedDoc) && meta.eol === meta.savedEol;
    if (clean) {
      replaceDoc(file.content, { history: false, flashChange: true });
      meta.savedDoc = view.state.doc;
      meta.savedMtime = file.mtime;
      meta.eol = meta.savedEol = file.eol;
      setEolState(file.eol);
      report();
      qc.invalidateQueries({ queryKey: ["git", root, "gutter", path] });
    } else {
      setBanner((b) => (b?.kind === "conflict" ? b : { kind: "external", diskMtime: file.mtime }));
    }
  }, [file?.mtime, deleted]);

  /* ---- preview mode ---- */
  const setMode = (m: "edit" | "preview") => {
    if (metaRef.current) metaRef.current.mode = m;
    setModeState(m);
    if (m === "preview" && viewRef.current) setPreviewText(viewRef.current.state.doc.toString());
  };
  useEffect(() => {
    if (mode !== "preview") return;
    const id = setInterval(() => viewRef.current && setPreviewText(viewRef.current.state.doc.toString()), 400);
    return () => clearInterval(id);
  }, [mode]);

  const toggleEol = () => {
    const meta = metaRef.current;
    if (!meta) return;
    meta.eol = meta.eol === "lf" ? "crlf" : "lf";
    setEolState(meta.eol);
    report();
  };

  const showPreview = preview && mode === "preview";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Breadcrumb
        path={path}
        dirty={dirty}
        saving={saving}
        canPreview={preview !== null}
        mode={mode}
        onMode={setMode}
        wrap={prefs.wrap}
        onWrap={toggleWrap}
        onSave={() => void doSave()}
        onReveal={() => {
          setActivity("explorer");
          setTimeout(() => bus.emit("reveal-in-explorer", { path }), 60);
        }}
      />
      {banner && (
        <BannerStrip
          banner={banner}
          onReload={() => void reloadFromDisk()}
          onOverwrite={() => void doSave(banner.diskMtime)}
          onKeepMine={() => {
            if (metaRef.current && banner.diskMtime) metaRef.current.savedMtime = banner.diskMtime;
            setBanner(null);
          }}
          onCompare={() => void openCompare()}
          onDismiss={() => setBanner(null)}
          onCloseTab={() => closeTab(tab.id)}
        />
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={host} className={showPreview ? "hidden" : "absolute inset-0"} />
        {showPreview && (preview === "markdown" ? <MarkdownPreview text={previewText} root={root} path={path} /> : <SvgPreview text={previewText} />)}
        {flash > 0 && <div key={flash} className="pointer-events-none absolute inset-0 animate-flash" />}
        {compare && <Compare disk={compare.disk} mine={compare.mine} lang={lang.id} onClose={() => setCompare(null)} />}
      </div>
      <StatusStrip status={status} language={lang.label} indent={indentLabel} eol={eol} onEol={toggleEol} size={file?.size ?? 0} savedAt={savedAt} saving={saving} />
    </div>
  );
}

