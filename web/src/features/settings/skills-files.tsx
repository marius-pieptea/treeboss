/**
 * The files of one skill: a lazy tree, with create / rename / delete, opening any file in the real editor.
 *
 * A skill is a folder (SKILL.md plus scripts, references, templates), so editing it means editing any of those, not
 * just the entry file. The daemon exposes a stored skill's folder as the file root `k_<name>`, which is exactly what
 * the editor tabs already speak; this component is the tree on top of it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Copy, FilePlus2, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { IconButton } from "@/components/ui/button";
import { ContextMenu, type MenuEntry } from "@/components/ui/overlay";
import { Skeleton, Spinner } from "@/components/ui/misc";
import { ask, confirm } from "@/components/ui/dialogs";
import { FileIcon } from "@/shell/FileIcon";
import { useUi } from "@/lib/store";
import { basename, cn } from "@/lib/utils";
import { skillFs, skillKeys, skillRoot } from "./skills-api";
import { countTree, formatBytes, isEntryFile, isMultiFile, parentOf, validateEntryPath, type FsEntry } from "./skills-logic";

const MAX_STAT_DIRS = 300;

/**
 * How many files a skill holds, found by walking its folder on demand (not for every skill in the list up front).
 * Shares its listings with the tree, so expanding folders afterwards costs nothing.
 */
export function useSkillStats(name: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: skillKeys.stats(name ?? ""),
    enabled: !!name,
    staleTime: 15_000,
    queryFn: async () => {
      const listing = new Map<string, FsEntry[]>();
      const queue = [""];
      let truncated = false;
      while (queue.length) {
        if (listing.size >= MAX_STAT_DIRS) {
          truncated = true;
          break;
        }
        const dir = queue.shift()!;
        const entries = await qc.fetchQuery({ queryKey: skillKeys.tree(name!, dir), queryFn: () => skillFs.tree(name!, dir), staleTime: 15_000 });
        listing.set(dir, entries);
        for (const e of entries) if (e.type === "dir") queue.push(e.path);
      }
      return { ...countTree(listing), truncated };
    },
  });
}

export function FileCountBadges({ name, compact }: { name: string; compact?: boolean }) {
  const s = useSkillStats(name);
  if (!s.data) return s.isLoading ? <Skeleton className={compact ? "h-3 w-14" : "h-[18px] w-16"} /> : null;
  const label = `${s.data.files}${s.data.truncated ? "+" : ""} ${s.data.files === 1 ? "file" : "files"}`;
  const detail = `${s.data.dirs} folder${s.data.dirs === 1 ? "" : "s"}, ${formatBytes(s.data.bytes)}`;
  const multi = isMultiFile(s.data.files);
  if (compact)
    return (
      <span className="whitespace-nowrap font-mono text-[10.5px] text-fg-faint" title={detail}>
        {label}
        {multi && <span className="text-accent"> · multi-file</span>}
      </span>
    );
  return (
    <>
      <span className="shrink-0 whitespace-nowrap rounded border border-line bg-raised px-1.5 py-px font-mono text-[10px] text-fg-muted" title={detail}>
        {label}
      </span>
      {multi && <span className="shrink-0 whitespace-nowrap rounded border border-accent/25 bg-accent-soft px-1.5 py-px font-mono text-[10px] text-accent">multi-file</span>}
    </>
  );
}

/** The compact count for a list row, looked up only once the row has scrolled into view (a long list does not walk every skill up front). */
export function LazyFileCount({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setSeen(true), io.disconnect()), { rootMargin: "80px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return <span ref={ref}>{seen ? <FileCountBadges name={name} compact /> : <span className="inline-block h-3" />}</span>;
}

/* -------------------------------------------------------------------------- */
/* The tree                                                                   */
/* -------------------------------------------------------------------------- */

interface Ctx {
  name: string;
  expanded: Set<string>;
  toggle(path: string, open?: boolean): void;
  open(path: string): void;
  menu(entry: FsEntry | null): MenuEntry[];
  act: { rename(e: FsEntry): void; remove(e: FsEntry): void };
  active: string | null;
}

function Level({ ctx, dir, depth }: { ctx: Ctx; dir: string; depth: number }) {
  const q = useQuery({ queryKey: skillKeys.tree(ctx.name, dir), queryFn: () => skillFs.tree(ctx.name, dir), staleTime: 5_000 });
  if (q.isLoading)
    return (
      <div style={{ paddingLeft: 12 + depth * 14 }} className="py-1">
        <Spinner className="size-3" />
      </div>
    );
  if (q.error) return <div style={{ paddingLeft: 12 + depth * 14 }} className="py-1 text-[11px] text-red">{(q.error as Error).message}</div>;
  const entries = q.data ?? [];
  if (!entries.length && depth > 0) return <div style={{ paddingLeft: 26 + depth * 14 }} className="py-0.5 text-[11px] text-fg-faint">empty</div>;
  return (
    <>
      {entries.map((e) => {
        const isDir = e.type === "dir";
        const open = isDir && ctx.expanded.has(e.path);
        const entry = !isDir && isEntryFile(e.path);
        return (
          <div key={e.path}>
            <ContextMenu entries={ctx.menu(e)}>
              <div
                role="treeitem"
                aria-expanded={isDir ? open : undefined}
                aria-selected={ctx.active === e.path}
                tabIndex={0}
                style={{ paddingLeft: 6 + depth * 14 }}
                onClick={() => (isDir ? ctx.toggle(e.path) : ctx.open(e.path))}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    isDir ? ctx.toggle(e.path) : ctx.open(e.path);
                  } else if (ev.key === "ArrowRight" && isDir) ctx.toggle(e.path, true);
                  else if (ev.key === "ArrowLeft" && isDir) ctx.toggle(e.path, false);
                  else if (ev.key === "F2") ctx.act.rename(e);
                  else if (ev.key === "Delete" || ev.key === "Backspace") ctx.act.remove(e);
                }}
                className={cn("group flex h-6 cursor-default items-center gap-1.5 rounded-md pr-2 text-[12.5px] outline-none transition-colors hover:bg-hover focus-visible:bg-hover", ctx.active === e.path && "bg-active")}
              >
                {isDir ? <ChevronRight className={cn("size-3 shrink-0 text-fg-faint transition-transform duration-150", open && "rotate-90")} /> : <span className="size-3 shrink-0" />}
                {isDir ? open ? <FolderOpen className="size-3.5 shrink-0 text-accent" /> : <Folder className="size-3.5 shrink-0 text-fg-muted" /> : <FileIcon name={e.name} className="size-3.5" />}
                <span className={cn("min-w-0 flex-1 truncate", entry && "font-medium")}>{e.name}</span>
                {entry && <span className="shrink-0 rounded bg-accent-soft px-1 font-mono text-[9px] text-accent">entry</span>}
                {!isDir && <span className="shrink-0 font-mono text-[10px] text-fg-faint opacity-0 transition-opacity group-hover:opacity-100">{formatBytes(e.size)}</span>}
              </div>
            </ContextMenu>
            {open && <Level ctx={ctx} dir={e.path} depth={depth + 1} />}
          </div>
        );
      })}
    </>
  );
}

export function SkillFiles({ name, storedPath, className }: { name: string; storedPath: string; className?: string }) {
  const qc = useQueryClient();
  const { openTab, closeTab } = useUi();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const root = skillRoot(name);

  const toggle = useCallback((path: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = open ?? !next.has(path);
      if (want) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: skillKeys.all(name) });
    qc.invalidateQueries({ queryKey: ["skills"] });
  }, [qc, name]);

  const openFile = useCallback(
    (path: string) => {
      setActive(path);
      openTab({ kind: "file", root, path, title: `${basename(path)} · ${name}` });
    },
    [openTab, root, name],
  );

  /** Tabs on a file that moved or went away would show a ghost: close them. */
  const closeTabsUnder = useCallback(
    (path: string) => {
      const s = useUi.getState();
      const tabs = s.current ? (s.byWs[s.current]?.tabs ?? []) : [];
      for (const t of tabs) if (t.kind === "file" && t.root === root && (t.path === path || t.path.startsWith(`${path}/`))) closeTab(t.id);
    },
    [root, closeTab],
  );

  const create = useCallback(
    async (type: "file" | "dir", baseDir: string) => {
      const value = await ask({
        title: type === "file" ? "New file" : "New folder",
        description: `Inside ${name}. Folders in the path are created for you.`,
        label: "Path",
        initial: baseDir ? `${baseDir}/` : "",
        placeholder: type === "file" ? "scripts/check.sh" : "references",
        confirmLabel: "Create",
        validate: (v) => validateEntryPath(v),
      });
      if (!value) return;
      const path = value.trim();
      try {
        await skillFs.create(name, path, type);
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) toggle(parts.slice(0, i).join("/"), true);
        refresh();
        if (type === "file") openFile(path);
      } catch (e: any) {
        toast.error(e.message);
      }
    },
    [name, refresh, openFile, toggle],
  );

  const rename = useCallback(
    async (e: FsEntry) => {
      if (isEntryFile(e.path)) {
        toast.error("SKILL.md must keep its name: it is how the skill is found.");
        return;
      }
      const value = await ask({ title: `Rename ${e.name}`, label: "New path", initial: e.path, confirmLabel: "Rename", validate: (v) => validateEntryPath(v, [], e.path) });
      if (!value || value.trim() === e.path) return;
      try {
        await skillFs.rename(name, e.path, value.trim());
        closeTabsUnder(e.path);
        refresh();
      } catch (err: any) {
        toast.error(err.message);
      }
    },
    [name, refresh, closeTabsUnder],
  );

  const remove = useCallback(
    async (e: FsEntry) => {
      if (isEntryFile(e.path)) {
        // The skill stops working without it: a plain confirm is too easy to click through.
        const typed = await ask({ title: "Delete SKILL.md?", description: `Without SKILL.md, ${name} is no longer a skill and agents will stop seeing it. Type its name to confirm.`, label: "Skill name", confirmLabel: "Delete SKILL.md", validate: (v) => (v.trim() === name ? null : `Type ${name} to confirm.`) });
        if (typed === null) return;
      } else if (!(await confirm({ title: `Delete ${e.name}?`, description: e.type === "dir" ? "The folder and everything in it are removed from this skill." : "The file is removed from this skill.", confirmLabel: "Delete", danger: true }))) return;
      try {
        await skillFs.remove(name, e.path);
        closeTabsUnder(e.path);
        refresh();
      } catch (err: any) {
        toast.error(err.message);
      }
    },
    [name, refresh, closeTabsUnder],
  );

  const menu = useCallback(
    (e: FsEntry | null): MenuEntry[] => {
      const base = e ? (e.type === "dir" ? e.path : parentOf(e.path)) : "";
      const items: MenuEntry[] = [
        { label: "New file…", icon: <FilePlus2 />, onSelect: () => void create("file", base) },
        { label: "New folder…", icon: <FolderPlus />, onSelect: () => void create("dir", base) },
      ];
      if (e) {
        items.push(
          { separator: true },
          { label: "Rename…", icon: <Pencil />, shortcut: "F2", onSelect: () => void rename(e) },
          { label: "Copy path", icon: <Copy />, onSelect: () => void navigator.clipboard.writeText(`${storedPath}/${e.path}`).then(() => toast.success("Path copied")) },
          { separator: true },
          { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => void remove(e) },
        );
      }
      return items;
    },
    [create, rename, remove, storedPath],
  );

  const ctx: Ctx = useMemo(() => ({ name, expanded, toggle, open: openFile, menu, act: { rename: (e) => void rename(e), remove: (e) => void remove(e) }, active }), [name, expanded, toggle, openFile, menu, rename, remove, active]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Files</span>
        <IconButton label="New file" size="icon-sm" onClick={() => void create("file", "")}>
          <FilePlus2 />
        </IconButton>
        <IconButton label="New folder" size="icon-sm" onClick={() => void create("dir", "")}>
          <FolderPlus />
        </IconButton>
        <IconButton label="Refresh files" size="icon-sm" onClick={refresh}>
          <RefreshCw />
        </IconButton>
      </div>
      <ContextMenu entries={menu(null)}>
        <div role="tree" aria-label={`Files in ${name}`} className="min-h-0 flex-1 overflow-y-auto p-1">
          <Level ctx={ctx} dir="" depth={0} />
        </div>
      </ContextMenu>
    </div>
  );
}
