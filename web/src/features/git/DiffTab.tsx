import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Columns2, ExternalLink, FileDiff, Minus, Plus, RefreshCw, Rows2, Undo2, WrapText, Rows4 } from "lucide-react";
import { get, url } from "@/lib/api";
import { buildHunkPatch, buildLinesPatch, parseDiff, type DiffHunk, type DiffLine } from "@/lib/diff";
import { useGitStatus, useRoot } from "@/lib/queries";
import { bus } from "@/lib/bus";
import { useUi, type Tab } from "@/lib/store";
import { basename, cn } from "@/lib/utils";
import { gitToFsPath } from "@/lib/workspace";
import type { DiffResult } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/button";
import { Badge, Empty, SegTabs, Skeleton, Spinner } from "@/components/ui/misc";
import { confirm } from "@/components/ui/dialogs";
import { DiffFileView, STATUS_META } from "./DiffBlocks";
import { gitActions } from "./actions";
import { gk } from "./queries";
import { useStored } from "./useStored";

type DiffTabData = Extract<Tab, { kind: "diff" }>;

const CONTEXT_STEPS = [3, 10, 30, 1000];

/**
 * One file's diff, with the controls to act on it: stage or unstage or discard a hunk, or just the lines
 * you pick. Read-only (no actions) when it shows a commit or a range.
 */
export function DiffTab({ tab }: { tab: DiffTabData }) {
  const root = tab.root;
  const openTab = useUi((s) => s.openTab);
  const rootInfo = useRoot(root);
  const prefix = rootInfo.data?.repo.prefix;
  const a = useMemo(() => gitActions(root), [root]);
  const status = useGitStatus(root);
  const conflicted = !!status.data?.files.some((f) => f.path === tab.path && f.conflict);

  const [mode, setMode] = useStored<"unified" | "split">("trb.git.diffMode", "unified");
  const [wrap, setWrap] = useStored<boolean>("trb.git.diffWrap", false);
  const [ctxStep, setCtxStep] = useState(0);
  const context = CONTEXT_STEPS[ctxStep];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selHunk, setSelHunk] = useState<number | null>(null);
  const anchor = useRef<string | null>(null);
  const [acting, setActing] = useState(false);
  const [current, setCurrent] = useState(0);

  const editable = !tab.commit && !(tab.base && tab.head);
  const params = { path: tab.path, staged: tab.staged, untracked: tab.untracked, commit: tab.commit, base: tab.base, head: tab.head, context };
  const q = useQuery({
    queryKey: gk.diff(root, params),
    queryFn: () => get<DiffResult>(url.git(root, "t/diff", params)),
    placeholderData: keepPreviousData,
    staleTime: 500,
  });

  const files = useMemo(() => parseDiff(q.data?.diff ?? ""), [q.data?.diff]);
  const file = files.find((f) => f.path === tab.path || f.oldPath === tab.path) ?? files[0];

  // A different diff (after a stage, a refetch) invalidates line ids: start the selection over.
  useEffect(() => {
    setSelected(new Set());
    setSelHunk(null);
    anchor.current = null;
  }, [q.data?.diff]);

  const hunkEls = useRef(new Map<number, HTMLElement>());
  const setHunkRef = useCallback((_f: number, h: number, el: HTMLElement | null) => {
    if (el) hunkEls.current.set(h, el);
    else hunkEls.current.delete(h);
  }, []);
  const go = (delta: number) => {
    if (!file || file.hunks.length === 0) return;
    const next = Math.min(file.hunks.length - 1, Math.max(0, current + delta));
    setCurrent(next);
    hunkEls.current.get(next)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const onToggle = (hunk: DiffHunk, line: DiffLine, shift: boolean) => {
    setSelected((prev) => {
      // Selection lives inside one hunk: patches are built per hunk.
      const base = selHunk === hunk.index ? new Set(prev) : new Set<string>();
      if (shift && anchor.current && selHunk === hunk.index) {
        const ids = hunk.lines.filter((l) => l.type !== "ctx").map((l) => l.id);
        const i = ids.indexOf(anchor.current);
        const j = ids.indexOf(line.id);
        if (i !== -1 && j !== -1) for (const id of ids.slice(Math.min(i, j), Math.max(i, j) + 1)) base.add(id);
        return base;
      }
      if (base.has(line.id)) base.delete(line.id);
      else base.add(line.id);
      anchor.current = line.id;
      return base;
    });
    setSelHunk(hunk.index);
  };

  const run = async (fn: () => Promise<boolean>) => {
    setActing(true);
    try {
      await fn();
    } finally {
      setActing(false);
    }
  };

  const stagedView = !!tab.staged;
  const hunkApply = (h: DiffHunk, what: "stage" | "unstage" | "discard") =>
    run(async () => {
      if (!file) return false;
      if (what === "discard" && !(await confirm({ title: "Discard this hunk?", description: "These lines are reverted in the file on disk. This cannot be undone.", confirmLabel: "Discard hunk", danger: true }))) return false;
      const patch = buildHunkPatch(file, h.index);
      return a.apply(patch, what === "stage" ? { cached: true } : what === "unstage" ? { cached: true, reverse: true } : { reverse: true });
    });
  const linesApply = (h: DiffHunk, what: "stage" | "unstage" | "discard") =>
    run(async () => {
      if (!file) return false;
      const sel = new Set(h.lines.filter((l) => selected.has(l.id)).map((l) => l.id));
      if (what === "discard" && !(await confirm({ title: `Discard ${sel.size} selected line${sel.size === 1 ? "" : "s"}?`, description: "They are reverted in the file on disk. This cannot be undone.", confirmLabel: "Discard lines", danger: true }))) return false;
      // Forward patches add to the target; reverse patches take away from it (unstage, discard).
      const patch = buildLinesPatch(file, h.index, sel, what === "stage" ? "forward" : "reverse");
      if (!patch) return false;
      return a.apply(patch, what === "stage" ? { cached: true } : what === "unstage" ? { cached: true, reverse: true } : { reverse: true });
    });

  const interactive = editable && file && !tab.untracked && !file.binary
    ? {
        selected,
        onToggle,
        hunkActions: (h: DiffHunk) => {
          const n = selHunk === h.index ? h.lines.filter((l) => selected.has(l.id)).length : 0;
          const btn = "!h-5 !px-1.5 !text-[10.5px]";
          return (
            <span className="flex shrink-0 items-center gap-1">
              {n > 0 ? (
                <>
                  <span className="text-accent">{n} line{n === 1 ? "" : "s"}</span>
                  {stagedView ? (
                    <Button size="xs" variant="subtle" className={btn} disabled={acting} onClick={() => linesApply(h, "unstage")}>
                      <Minus /> Unstage lines
                    </Button>
                  ) : (
                    <>
                      <Button size="xs" variant="subtle" className={btn} disabled={acting} onClick={() => linesApply(h, "stage")}>
                        <Plus /> Stage lines
                      </Button>
                      <Button size="xs" variant="ghost" className={cn(btn, "text-red hover:text-red")} disabled={acting} onClick={() => linesApply(h, "discard")}>
                        <Undo2 /> Discard
                      </Button>
                    </>
                  )}
                  <Button size="xs" variant="ghost" className={btn} onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                </>
              ) : stagedView ? (
                <Button size="xs" variant="subtle" className={btn} disabled={acting} onClick={() => hunkApply(h, "unstage")}>
                  <Minus /> Unstage hunk
                </Button>
              ) : (
                <>
                  <Button size="xs" variant="subtle" className={btn} disabled={acting} onClick={() => hunkApply(h, "stage")}>
                    <Plus /> Stage hunk
                  </Button>
                  <Button size="xs" variant="ghost" className={cn(btn, "text-red hover:text-red")} disabled={acting} onClick={() => hunkApply(h, "discard")}>
                    <Undo2 /> Discard
                  </Button>
                </>
              )}
            </span>
          );
        },
      }
    : undefined;

  const openFile = () => {
    const fsPath = gitToFsPath(tab.path, prefix);
    if (fsPath === null) return;
    const line = file?.hunks[Math.min(current, Math.max(0, (file?.hunks.length ?? 1) - 1))]?.newStart ?? 1;
    openTab({ kind: "file", root, path: fsPath, title: basename(fsPath), line });
    bus.emit("editor-goto", { path: fsPath, line });
  };

  const wholeFile = async (what: "stage" | "unstage" | "discard") => {
    if (what === "discard") {
      const ok = await confirm({ title: tab.untracked ? `Delete ${basename(tab.path)}?` : `Discard all changes to ${basename(tab.path)}?`, description: tab.untracked ? "The file is not tracked by git. It is deleted from disk." : "This cannot be undone.", confirmLabel: tab.untracked ? "Delete file" : "Discard changes", danger: true });
      if (!ok) return;
    }
    await run(() => (what === "stage" ? a.stage([tab.path]) : what === "unstage" ? a.unstage([tab.path]) : a.discard([tab.path])));
  };

  const meta = file ? STATUS_META[file.status] : null;
  const empty = !q.isLoading && !q.error && (!file || (file.hunks.length === 0 && !file.binary && file.status === "modified" && !file.oldMode));

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" onKeyDown={(e) => e.key === "F7" && (e.preventDefault(), go(e.shiftKey ? -1 : 1))} tabIndex={-1}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2.5">
        {meta && (
          <Badge tone={meta.tone} title={meta.label}>
            {meta.letter}
          </Badge>
        )}
        <span className="min-w-0 truncate font-mono text-[12px]" title={tab.path}>
          {tab.path}
        </span>
        <span className="shrink-0 text-[11px] text-fg-faint">{tab.commit ? `in ${tab.commit.slice(0, 7)}` : tab.base ? `${tab.base.slice(0, 7)}..${tab.head?.slice(0, 7)}` : stagedView ? "staged" : tab.untracked ? "new file" : "working tree"}</span>
        {file && !file.binary && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-green">+{file.additions}</span> <span className="text-red">−{file.deletions}</span>
          </span>
        )}
        {(q.isFetching && !q.isLoading) && <Spinner />}
        <div className="flex-1" />
        {file && file.hunks.length > 0 && (
          <div className="flex items-center">
            <IconButton label="Previous change" shortcut="Shift+F7" size="icon-sm" onClick={() => go(-1)} disabled={current <= 0}>
              <ChevronUp />
            </IconButton>
            <span className="min-w-[3ch] text-center font-mono text-[10.5px] text-fg-faint">
              {Math.min(current + 1, file.hunks.length)}/{file.hunks.length}
            </span>
            <IconButton label="Next change" shortcut="F7" size="icon-sm" onClick={() => go(1)} disabled={current >= file.hunks.length - 1}>
              <ChevronDown />
            </IconButton>
          </div>
        )}
        {editable && !tab.untracked && !stagedView && file && (
          <>
            <Button size="xs" variant="subtle" disabled={acting} onClick={() => wholeFile("stage")}>
              <Plus /> Stage file
            </Button>
            <IconButton label="Discard all changes to this file" size="icon-sm" onClick={() => wholeFile("discard")} disabled={acting}>
              <Undo2 />
            </IconButton>
          </>
        )}
        {editable && tab.untracked && (
          <>
            <Button size="xs" variant="subtle" disabled={acting} onClick={() => wholeFile("stage")}>
              <Plus /> Stage file
            </Button>
            <IconButton label="Delete this untracked file" size="icon-sm" onClick={() => wholeFile("discard")} disabled={acting}>
              <Undo2 />
            </IconButton>
          </>
        )}
        {editable && stagedView && file && (
          <Button size="xs" variant="subtle" disabled={acting} onClick={() => wholeFile("unstage")}>
            <Minus /> Unstage file
          </Button>
        )}
        <SegTabs
          value={mode}
          onChange={setMode}
          className="w-[84px]"
          items={[
            { value: "unified", label: <Rows2 className="size-3.5" /> },
            { value: "split", label: <Columns2 className="size-3.5" /> },
          ]}
        />
        <IconButton label={ctxStep < CONTEXT_STEPS.length - 1 ? `Show more context (${CONTEXT_STEPS[ctxStep + 1] === 1000 ? "whole file" : `${CONTEXT_STEPS[ctxStep + 1]} lines`})` : "Showing the whole file"} size="icon-sm" onClick={() => setCtxStep((s) => Math.min(CONTEXT_STEPS.length - 1, s + 1))} disabled={ctxStep >= CONTEXT_STEPS.length - 1}>
          <Rows4 />
        </IconButton>
        <IconButton label={wrap ? "Do not wrap lines" : "Wrap long lines"} size="icon-sm" onClick={() => setWrap(!wrap)} className={cn(wrap && "text-accent")}>
          <WrapText />
        </IconButton>
        <IconButton label="Refresh" size="icon-sm" onClick={() => q.refetch()}>
          <RefreshCw className={cn(q.isFetching && "animate-spin-fast")} />
        </IconButton>
        <IconButton label="Open file" size="icon-sm" onClick={openFile} disabled={!file || file.status === "deleted" || gitToFsPath(tab.path, prefix) === null}>
          <ExternalLink />
        </IconButton>
      </div>

      {q.data?.truncated && <div className="border-b border-line bg-amber/10 px-3 py-1.5 text-[11.5px] text-amber">This diff is larger than 1 MB and was cut off. Open the file to see everything.</div>}

      <div className="min-h-0 flex-1 overflow-auto">
        {q.isLoading ? (
          <div className="space-y-1.5 p-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} style={{ width: `${55 + ((i * 37) % 40)}%` }}>
                <Skeleton className="h-4" />
              </div>
            ))}
          </div>
        ) : q.error ? (
          <Empty icon={<FileDiff />} title="Could not load this diff" hint={(q.error as Error).message} action={<Button onClick={() => q.refetch()}>Try again</Button>} />
        ) : conflicted ? (
          <Empty
            icon={<FileDiff />}
            title="This file has merge conflicts"
            hint="A normal diff cannot show a conflict. Open the file to edit the markers by hand, or accept one side from Source Control."
            action={
              <Button size="sm" variant="primary" onClick={openFile} disabled={gitToFsPath(tab.path, prefix) === null}>
                Open file
              </Button>
            }
          />
        ) : empty ? (
          <Empty
            icon={<FileDiff />}
            title={stagedView ? "Nothing staged for this file" : tab.commit ? "No changes in this commit for this file" : "No unstaged changes in this file"}
            hint={stagedView ? "It was unstaged or committed." : "It was staged, committed, or reverted."}
            action={
              !stagedView && editable ? (
                <Button size="sm" onClick={() => openTab({ kind: "diff", root, path: tab.path, title: `${basename(tab.path)} (staged)`, staged: true })}>
                  View staged changes
                </Button>
              ) : undefined
            }
          />
        ) : file ? (
          <div className="min-w-0">
            <DiffFileView key={`${file.path}:${mode}`} file={file} mode={mode} wrap={wrap} collapsed={false} onToggle={() => {}} bare interactive={interactive} hunkRef={setHunkRef} />
          </div>
        ) : null}
      </div>
      {interactive && file && file.hunks.length > 0 && <div className="border-t border-line px-3 py-1 text-[10.5px] text-fg-faint">Click a line number to select it (shift-click for a range), then stage, unstage or discard just those lines.</div>}
    </div>
  );
}
