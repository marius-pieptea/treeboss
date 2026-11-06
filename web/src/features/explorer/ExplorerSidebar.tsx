import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ChevronRight, ChevronsDownUp, FilePlus2, FolderClosed, FolderOpen, FolderPlus, Link2, RefreshCw, Target } from "lucide-react";
import { toast } from "sonner";
import { get, url } from "@/lib/api";
import { bus } from "@/lib/bus";
import { isMac, useElementSize } from "@/lib/hooks";
import { qk, useGitStatus } from "@/lib/queries";
import { useUi, useWs } from "@/lib/store";
import type { TreeEntry } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";
import { basename, cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { ContextMenu, type MenuEntry } from "@/components/ui/overlay";
import { Empty, Skeleton } from "@/components/ui/misc";
import { FileIcon } from "@/shell/FileIcon";
import { useSearch } from "../search/store";
import { InlineName } from "./InlineName";
import { createEntry, deleteEntry, duplicateEntry, hasUnsavedUnder, refreshTree, renameEntry, revealEntry } from "./ops";
import { useExplorer } from "./store";
import { ROW_HEIGHT, ancestors, buildDecorations, flattenTree, isNoopMove, join, moveBlocked, moveTarget, parentOf, rowKey, scrollToReveal, uniqueCopyName, visibleWindow, type InlineInput, type Listing, type Row, type Tone } from "./tree";

const toneClass: Record<Tone, string> = { red: "text-red", amber: "text-amber", green: "text-green", blue: "text-blue", violet: "text-violet" };

/** The file manager's name on this platform: Finder, Explorer, or the generic term. */
const revealLabel = isMac ? "Reveal in Finder" : /Win/.test(navigator.platform) ? "Show in Explorer" : "Show in file manager";

export function ExplorerSidebar() {
  const { root, workspace, repo } = useWorkspace();
  const ws = useWs();
  const { toggleExpanded, openTab } = useUi();
  const explorer = useExplorer();
  const git = useGitStatus(root);
  const [inline, setInline] = useState<InlineInput | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragSrc = useRef<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [sizeRef, size] = useElementSize<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);
  const revealTarget = useRef<string | null>(null);

  /* ---- data: one listing per visible expanded directory ---- */
  const expandedSet = useMemo(() => new Set(ws.expanded), [ws.expanded]);
  const dirs = useMemo(() => ["", ...ws.expanded.filter((d) => ancestors(d).every((a) => expandedSet.has(a)))], [ws.expanded, expandedSet]);
  const results = useQueries({
    queries: dirs.map((d) => ({
      queryKey: qk.tree(root, d),
      queryFn: () => get<{ entries: TreeEntry[] }>(url.fs(root, "tree", { path: d })).then((r) => r.entries),
      staleTime: 3000,
      retry: false,
    })),
  });
  const listings = useMemo(() => {
    const m = new Map<string, Listing>();
    dirs.forEach((d, i) => {
      const r = results[i];
      m.set(d, r.data ? r.data : r.isError ? "error" : "loading");
    });
    return m;
    // `results` is a new array every render; its elements' data identity is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirs, ...results.map((r) => r.data), ...results.map((r) => r.isError)]);

  const rows = useMemo(() => flattenTree(listings, expandedSet, inline), [listings, expandedSet, inline]);
  const deco = useMemo(() => buildDecorations(git.data?.files ?? [], repo?.prefix), [git.data?.files, repo?.prefix]);

  const fileCount = useQuery({ queryKey: ["fs", root, "find"], queryFn: () => get<{ files: string[] }>(url.fs(root, "find")).then((r) => r.files), staleTime: 60_000 });

  const siblingsOf = useCallback(
    (dir: string): string[] => {
      const l = listings.get(dir);
      return Array.isArray(l) ? l.map((e) => e.name) : [];
    },
    [listings],
  );

  /* ---- selection, keyboard, reveal ---- */
  const entryRows = useMemo(() => rows.filter((r): r is Extract<Row, { kind: "entry" }> => r.kind === "entry"), [rows]);
  const selectedIndex = rows.findIndex((r) => r.kind === "entry" && r.entry.path === explorer.selected);

  useEffect(() => {
    const i = selectedIndex;
    if (i < 0 || !scroller.current) return;
    const to = scrollToReveal(i, scroller.current.scrollTop, size.height);
    if (to !== null) scroller.current.scrollTop = to;
  }, [selectedIndex, size.height]);

  const reveal = useCallback(
    (path: string) => {
      for (const a of ancestors(path)) toggleExpanded(a, true);
      useExplorer.getState().select(path, false);
      revealTarget.current = path;
    },
    [toggleExpanded],
  );

  // A reveal asked for before this sidebar existed (the command palette sets it, then switches the sidebar here).
  useEffect(() => {
    const pending = useExplorer.getState().pendingReveal;
    if (pending) {
      reveal(pending);
      useExplorer.getState().clearReveal();
    }
    return bus.on("reveal-in-explorer", ({ path }) => reveal(path));
  }, [reveal]);

  // Follow the active editor tab.
  const activeFile = ws.tabs.find((t) => t.id === ws.activeTab && t.kind === "file");
  const activePath = activeFile?.kind === "file" ? activeFile.path : null;
  useEffect(() => {
    if (activePath && useExplorer.getState().autoReveal) reveal(activePath);
  }, [activePath, reveal]);

  // Once the revealed row exists (its folders may still be loading), scroll to it.
  useEffect(() => {
    const t = revealTarget.current;
    if (!t || !scroller.current) return;
    const i = rows.findIndex((r) => r.kind === "entry" && r.entry.path === t);
    if (i < 0) return;
    revealTarget.current = null;
    const to = scrollToReveal(i, scroller.current.scrollTop, size.height);
    if (to !== null) scroller.current.scrollTop = Math.max(0, to - ROW_HEIGHT * 3);
  }, [rows, size.height]);

  /* ---- actions ---- */
  const open = (e: TreeEntry, pin: boolean) => {
    if (e.type === "dir") return toggleExpanded(e.path);
    openTab({ kind: "file", root, path: e.path, title: e.name, preview: !pin });
  };

  const startNew = (mode: "file" | "dir", parent: string) => {
    if (parent) toggleExpanded(parent, true);
    setInline({ mode, parent });
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      toast.error(label, { description: e?.message });
    }
  };

  const commitInline = (name: string) => {
    const inp = inline;
    setInline(null);
    if (!inp) return;
    if (inp.mode === "rename" && inp.target) {
      const to = join(inp.parent, name);
      void run(`Could not rename ${basename(inp.target)}`, async () => {
        await renameEntry(root, inp.target!, to);
        explorer.select(to, false);
      });
      return;
    }
    const path = join(inp.parent, name);
    void run(`Could not create ${path}`, async () => {
      await createEntry(root, path, inp.mode === "dir" ? "dir" : "file");
      for (const a of ancestors(path)) toggleExpanded(a, true);
      if (inp.mode === "dir") {
        toggleExpanded(path, true);
        explorer.select(path, true);
      } else {
        explorer.select(path, false);
        openTab({ kind: "file", root, path, title: basename(path) });
      }
    });
  };

  const del = async (e: TreeEntry) => {
    const unsaved = hasUnsavedUnder(root, e.path);
    const ok = await confirm({
      title: `Delete ${e.name}?`,
      description: `${e.type === "dir" ? "This folder and everything in it will be deleted from disk." : "This file will be deleted from disk."}${unsaved ? " It has unsaved changes that will be lost." : ""} This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) void run(`Could not delete ${e.name}`, () => deleteEntry(root, e.path));
  };

  const duplicate = (e: TreeEntry) => {
    const parent = parentOf(e.path);
    const to = join(parent, uniqueCopyName(e.name, siblingsOf(parent)));
    void run(`Could not duplicate ${e.name}`, async () => {
      await duplicateEntry(root, e.path, to);
      explorer.select(to, e.type === "dir");
    });
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => toast.success("Copied", { description: text, duration: 1500 }));
  };

  const showInManager = (e: TreeEntry) => void run(`Could not show ${e.name}`, () => revealEntry(root, e.path));

  const searchIn = (dir: string) => {
    useUi.getState().setActivity("search");
    useSearch.getState().prefill({ include: dir ? `${dir}/**` : "" });
  };

  const menuFor = (e: TreeEntry | null): MenuEntry[] => {
    const dir = e ? (e.type === "dir" ? e.path : parentOf(e.path)) : "";
    const base: MenuEntry[] = [
      { label: "New file…", icon: <FilePlus2 />, onSelect: () => startNew("file", dir) },
      { label: "New folder…", icon: <FolderPlus />, onSelect: () => startNew("dir", dir) },
    ];
    if (!e) return [...base, { separator: true }, { label: "Search in workspace", onSelect: () => searchIn("") }, { label: "Refresh", icon: <RefreshCw />, onSelect: () => refreshTree(root) }];
    return [
      ...base,
      { separator: true },
      { label: "Rename", shortcut: "F2", onSelect: () => setInline({ mode: "rename", parent: parentOf(e.path), target: e.path }) },
      { label: "Duplicate", onSelect: () => duplicate(e) },
      { label: "Delete", shortcut: "Del", danger: true, onSelect: () => void del(e) },
      { separator: true },
      { label: "Copy path", onSelect: () => copy(`${workspace.path}/${e.path}`) },
      { label: "Copy relative path", onSelect: () => copy(e.path) },
      { label: revealLabel, icon: <FolderOpen />, onSelect: () => showInManager(e) },
      ...(e.type === "dir" ? [{ separator: true } as MenuEntry, { label: "Search in folder", onSelect: () => searchIn(e.path) }, { label: "Refresh", icon: <RefreshCw />, onSelect: () => refreshTree(root) }] : []),
    ];
  };

  /* ---- keyboard ---- */
  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (inline) return;
    const cur = entryRows.findIndex((r) => r.entry.path === explorer.selected);
    const at = cur >= 0 ? entryRows[cur] : null;
    const move = (to: number) => {
      const r = entryRows[Math.min(Math.max(to, 0), entryRows.length - 1)];
      if (r) explorer.select(r.entry.path, r.entry.type === "dir");
    };
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        return move(cur + 1);
      case "ArrowUp":
        ev.preventDefault();
        return move(cur <= 0 ? 0 : cur - 1);
      case "Home":
        ev.preventDefault();
        return move(0);
      case "End":
        ev.preventDefault();
        return move(entryRows.length - 1);
      case "ArrowRight":
        if (!at || at.entry.type !== "dir") return;
        ev.preventDefault();
        return at.expanded ? move(cur + 1) : toggleExpanded(at.entry.path, true);
      case "ArrowLeft": {
        if (!at) return;
        ev.preventDefault();
        if (at.entry.type === "dir" && at.expanded) return toggleExpanded(at.entry.path, false);
        const p = parentOf(at.entry.path);
        const pi = entryRows.findIndex((r) => r.entry.path === p);
        return pi >= 0 ? move(pi) : undefined;
      }
      case "Enter":
        if (at) {
          ev.preventDefault();
          open(at.entry, true);
        }
        return;
      case "F2":
        if (at) {
          ev.preventDefault();
          setInline({ mode: "rename", parent: parentOf(at.entry.path), target: at.entry.path });
        }
        return;
      case "Delete":
      case "Backspace":
        if (at && (ev.key === "Delete" || ev.metaKey)) {
          ev.preventDefault();
          void del(at.entry);
        }
        return;
    }
  };

  /* ---- drag and drop ---- */
  const destFor = (e: TreeEntry | null) => (e ? (e.type === "dir" ? e.path : parentOf(e.path)) : "");
  const onDragOver = (ev: React.DragEvent, e: TreeEntry | null) => {
    const src = dragSrc.current;
    if (!src) return;
    ev.stopPropagation();
    const dest = destFor(e);
    if (moveBlocked(src, dest) || isNoopMove(src, dest)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    if (dropTarget !== dest) {
      setDropTarget(dest);
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      // Hovering a closed folder opens it, so a deep target is reachable in one drag.
      if (e?.type === "dir" && !expandedSet.has(e.path)) hoverTimer.current = setTimeout(() => toggleExpanded(e.path, true), 650);
    }
  };
  const onDrop = (ev: React.DragEvent, e: TreeEntry | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    const src = dragSrc.current;
    dragSrc.current = null;
    setDropTarget(null);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (!src) return;
    const dest = destFor(e);
    const blocked = moveBlocked(src, dest);
    if (blocked) return void toast.error(blocked);
    if (isNoopMove(src, dest)) return;
    void run(`Could not move ${basename(src)}`, async () => {
      await renameEntry(root, src, moveTarget(src, dest));
      if (dest) toggleExpanded(dest, true);
    });
  };

  /* ---- render ---- */
  const win = visibleWindow(rows.length, scrollTop, size.height);
  const rootListing = listings.get("");
  const loadingRoot = rootListing === "loading";
  const rootEmpty = Array.isArray(rootListing) && rootListing.length === 0 && !inline;

  const renderRow = (row: Row, index: number) => {
    const top = index * ROW_HEIGHT;
    const pad = 10 + row.depth * 14;
    const guides = Array.from({ length: row.depth }, (_, d) => <span key={d} className="pointer-events-none absolute inset-y-0 w-px bg-line/70" style={{ left: 16 + d * 14 }} />);

    if (row.kind === "status") {
      return (
        <div key={rowKey(row)} className={cn("absolute inset-x-0 flex items-center text-[11.5px]", row.tone === "error" ? "text-red" : "text-fg-faint")} style={{ top, height: ROW_HEIGHT, paddingLeft: pad + 18 }}>
          {guides}
          {row.text === "Loading…" ? <Skeleton className="h-2.5 w-24" /> : row.text}
        </div>
      );
    }
    if (row.kind === "input") {
      const target = row.input.target;
      return (
        <div key={rowKey(row)} className="absolute inset-x-0" style={{ top, height: ROW_HEIGHT }}>
          {guides}
          <InlineName depth={row.depth} initial={row.initial} siblings={siblingsOf(row.input.parent)} allowPath={row.input.mode !== "rename"} current={target ? basename(target) : undefined} onCommit={commitInline} onCancel={() => setInline(null)} />
        </div>
      );
    }

    const e = row.entry;
    const selected = explorer.selected === e.path;
    const isDir = e.type === "dir";
    const fileDeco = isDir ? null : deco.files.get(e.path);
    const dirDeco = isDir ? deco.dirs.get(e.path) : null;
    const dest = destFor(e);
    const dropOn = dropTarget !== null && dropTarget === dest && (isDir || dest !== "");
    return (
      <ContextMenu key={rowKey(row)} entries={menuFor(e)}>
        <div
          role="treeitem"
          aria-level={row.depth + 1}
          aria-selected={selected}
          aria-expanded={isDir ? row.expanded : undefined}
          data-path={e.path}
          title={e.path}
          draggable
          onDragStart={(ev) => {
            dragSrc.current = e.path;
            ev.dataTransfer.effectAllowed = "move";
            ev.dataTransfer.setData("text/plain", e.path);
          }}
          onDragEnd={() => {
            dragSrc.current = null;
            setDropTarget(null);
          }}
          onDragOver={(ev) => onDragOver(ev, e)}
          onDrop={(ev) => onDrop(ev, e)}
          onClick={() => {
            explorer.select(e.path, isDir);
            scroller.current?.focus({ preventScroll: true });
            open(e, false);
          }}
          onDoubleClick={() => !isDir && open(e, true)}
          onContextMenu={() => explorer.select(e.path, isDir)}
          style={{ top, height: ROW_HEIGHT, paddingLeft: pad }}
          className={cn("group absolute inset-x-1 flex cursor-default items-center gap-1 rounded-md pr-2 text-[12.5px] transition-colors", selected ? "bg-active text-fg" : "text-fg-muted hover:bg-hover hover:text-fg", dropOn && "bg-accent-soft ring-1 ring-accent/50", e.ignored && "opacity-55")}
        >
          {guides}
          {isDir ? <ChevronRight className={cn("size-3 shrink-0 text-fg-faint transition-transform duration-150", row.expanded && "rotate-90")} /> : <span className="w-3 shrink-0" />}
          {isDir ? row.expanded ? <FolderOpen className="size-4 shrink-0 text-accent/80" /> : <FolderClosed className="size-4 shrink-0 text-accent/60" /> : <FileIcon name={e.name} className="size-4" />}
          <span className={cn("min-w-0 flex-1 truncate", fileDeco && toneClass[fileDeco.tone], dirDeco && !row.expanded && toneClass[dirDeco.tone])}>{e.name}</span>
          {e.symlink && <Link2 className="size-3 shrink-0 text-fg-faint" aria-label="symbolic link" />}
          {fileDeco && (
            <span title={fileDeco.label} className={cn("w-3.5 shrink-0 text-center font-mono text-[10.5px] font-semibold", toneClass[fileDeco.tone])}>
              {fileDeco.letter}
            </span>
          )}
          {dirDeco && <span title={`${dirDeco.count} changed`} className={cn("size-1.5 shrink-0 rounded-full bg-current", toneClass[dirDeco.tone])} />}
        </div>
      </ContextMenu>
    );
  };

  const target = explorer.selectedIsDir ? explorer.selected : parentOf(explorer.selected);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between pl-3 pr-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Explorer</span>
        <div className="flex items-center">
          <IconButton label="New file" size="icon-sm" onClick={() => startNew("file", target)}>
            <FilePlus2 />
          </IconButton>
          <IconButton label="New folder" size="icon-sm" onClick={() => startNew("dir", target)}>
            <FolderPlus />
          </IconButton>
          <IconButton label="Refresh" size="icon-sm" onClick={() => refreshTree(root)}>
            <RefreshCw />
          </IconButton>
          <IconButton label="Collapse all folders" size="icon-sm" onClick={() => ws.expanded.forEach((p) => toggleExpanded(p, false))}>
            <ChevronsDownUp />
          </IconButton>
          <IconButton label={explorer.autoReveal ? "Following the active file" : "Not following the active file"} size="icon-sm" onClick={() => explorer.setAutoReveal(!explorer.autoReveal)} className={cn(explorer.autoReveal && "bg-accent-soft text-accent")}>
            <Target />
          </IconButton>
        </div>
      </div>

      <ContextMenu entries={menuFor(null)}>
        <div ref={sizeRef} className="relative min-h-0 flex-1" onDragOver={(ev) => onDragOver(ev, null)} onDrop={(ev) => onDrop(ev, null)}>
          <div ref={scroller} tabIndex={0} role="tree" aria-label="Files" onKeyDown={onKeyDown} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="absolute inset-0 overflow-y-auto overflow-x-hidden outline-none">
            {loadingRoot ? (
              <div className="flex flex-col gap-2 p-3">
                {[70, 45, 60, 38, 52].map((w, i) => (
                  <div key={i} style={{ width: `${w}%` }}>
                    <Skeleton className="h-3" />
                  </div>
                ))}
              </div>
            ) : rootEmpty ? (
              <Empty icon={<FolderOpen />} title="This folder is empty" hint="Create a file to get started." />
            ) : (
              <div className="relative" style={{ height: rows.length * ROW_HEIGHT + 16 }}>
                {rows.slice(win.start, win.end).map((row, i) => renderRow(row, win.start + i))}
              </div>
            )}
          </div>
          {dropTarget === "" && dragSrc.current && <div className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-inset ring-accent/50" />}
        </div>
      </ContextMenu>

      <div className="flex h-6 shrink-0 items-center justify-between border-t border-line px-3 font-mono text-[10.5px] text-fg-faint">
        <span>{fileCount.data ? `${fileCount.data.length.toLocaleString()} files` : "…"}</span>
        <span className={cn(git.data && git.data.files.length > 0 && "text-amber")}>{git.data ? (git.data.files.length ? `${git.data.files.length} changed` : "clean") : ""}</span>
      </div>
    </div>
  );
}
