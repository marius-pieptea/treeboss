import { memo, useState } from "react";
import { FileSymlink, Plus, Minus, RotateCcw, SquarePen, Undo2 } from "lucide-react";
import type { GitFile } from "@/lib/types";
import { useUi } from "@/lib/store";
import { basename, cn, dirname } from "@/lib/utils";
import { gitToFsPath } from "@/lib/workspace";
import { IconButton } from "@/components/ui/button";
import { ContextMenu, Tooltip } from "@/components/ui/overlay";
import { Badge, Section } from "@/components/ui/misc";
import { confirm } from "@/components/ui/dialogs";
import { FileIcon } from "@/shell/FileIcon";
import { gitActions } from "./actions";

const ROW_LIMIT = 200;

type Group = "conflicts" | "staged" | "changes";

const TONE: Record<string, "green" | "amber" | "red" | "violet" | "blue"> = { M: "amber", A: "green", D: "red", R: "violet", C: "violet", T: "blue", U: "green", "!": "red" };

export function letterFor(f: GitFile, group: Group): string {
  if (group === "conflicts") return "!";
  if (group === "staged") return f.index;
  return f.worktree === "?" ? "U" : f.worktree;
}

const WORDS: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Untracked", "!": "Merge conflict" };

export function useOpenFile(root: string, prefix: string | undefined) {
  const openTab = useUi((s) => s.openTab);
  return {
    diff(f: GitFile, group: Group, preview = true) {
      if (group === "conflicts") return this.file(f);
      const staged = group === "staged";
      const untracked = !staged && f.worktree === "?";
      const label = staged ? "staged" : untracked ? "new" : "changes";
      openTab({ kind: "diff", root, path: f.path, title: `${basename(f.path)} (${label})`, staged, untracked, preview });
    },
    file(f: GitFile) {
      const fsPath = gitToFsPath(f.path, prefix);
      // A file deleted from disk has nothing to open.
      if (fsPath === null || f.worktree === "D" || (f.index === "D" && f.worktree === ".")) return false;
      openTab({ kind: "file", root, path: fsPath, title: basename(fsPath) });
      return true;
    },
  };
}

const Row = memo(function Row({ f, group, root, prefix, selectedId }: { f: GitFile; group: Group; root: string; prefix: string | undefined; selectedId: string | null }) {
  const open = useOpenFile(root, prefix);
  const a = gitActions(root);
  const letter = letterFor(f, group);
  const name = basename(f.path);
  const dir = dirname(f.path);
  const id = `${group}:${f.path}`;
  const untracked = f.worktree === "?";

  const discard = async () => {
    const ok = await confirm({
      title: untracked ? `Delete ${name}?` : `Discard changes to ${name}?`,
      description: untracked ? "This file is not tracked by git. Discarding it deletes it from disk, and it cannot be recovered." : group === "staged" ? "This resets the file to HEAD, dropping both staged and unstaged edits. It cannot be undone." : "Your edits to this file will be lost. This cannot be undone.",
      confirmLabel: untracked ? "Delete file" : "Discard changes",
      danger: true,
    });
    if (ok) void a.discard([f.path], group === "staged");
  };

  const menu = [
    { label: "Open changes", onSelect: () => open.diff(f, group, false) },
    { label: "Open file", icon: <FileSymlink />, onSelect: () => open.file(f), disabled: gitToFsPath(f.path, prefix) === null },
    { separator: true },
    ...(group === "conflicts"
      ? [
          { label: "Accept current (ours)", onSelect: () => a.resolve(f.path, "ours") },
          { label: "Accept incoming (theirs)", onSelect: () => a.resolve(f.path, "theirs") },
        ]
      : group === "staged"
        ? [{ label: "Unstage", icon: <Minus />, onSelect: () => a.unstage([f.path]) }]
        : [{ label: "Stage", icon: <Plus />, onSelect: () => a.stage([f.path]) }]),
    ...(group !== "conflicts" ? [{ label: untracked ? "Delete file…" : "Discard changes…", icon: <Undo2 />, danger: true, onSelect: discard }] : []),
    { separator: true },
    { label: "Copy path", onSelect: () => navigator.clipboard.writeText(f.path) },
  ];

  return (
    <ContextMenu entries={menu}>
      <div
        role="treeitem"
        tabIndex={0}
        aria-selected={selectedId === id}
        data-path={f.path}
        onClick={() => open.diff(f, group)}
        onDoubleClick={() => (group === "conflicts" ? open.file(f) : open.diff(f, group, false))}
        onKeyDown={(e) => {
          if (e.key === "Enter") open.diff(f, group, false);
          if (e.key === " ") {
            e.preventDefault();
            void (group === "staged" ? a.unstage([f.path]) : group === "changes" ? a.stage([f.path]) : undefined);
          }
        }}
        className="group/row flex h-[26px] cursor-default items-center gap-1.5 px-2 text-[12.5px] outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
      >
        <FileIcon name={f.path} className="size-3.5" />
        <span className={cn("shrink-0 truncate", f.worktree === "D" || f.index === "D" ? "text-fg-muted line-through decoration-fg-faint" : "")}>{name}</span>
        {f.origPath && <span className="truncate text-[11px] text-fg-faint">← {basename(f.origPath)}</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-faint">{dir}</span>
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {group !== "conflicts" && (
            <>
              <IconButton label="Open file" size="icon-xs" onClick={() => open.file(f)} disabled={gitToFsPath(f.path, prefix) === null}>
                <SquarePen />
              </IconButton>
              <IconButton label={untracked ? "Delete file" : "Discard changes"} size="icon-xs" onClick={discard}>
                <RotateCcw />
              </IconButton>
              {group === "staged" ? (
                <IconButton label="Unstage" size="icon-xs" onClick={() => a.unstage([f.path])}>
                  <Minus />
                </IconButton>
              ) : (
                <IconButton label="Stage" size="icon-xs" onClick={() => a.stage([f.path])}>
                  <Plus />
                </IconButton>
              )}
            </>
          )}
          {group === "conflicts" && (
            <>
              <button onClick={() => a.resolve(f.path, "ours")} className="rounded px-1.5 py-0.5 text-[10.5px] text-fg-muted outline-none hover:bg-active hover:text-fg" title="Keep our version">
                Ours
              </button>
              <button onClick={() => a.resolve(f.path, "theirs")} className="rounded px-1.5 py-0.5 text-[10.5px] text-fg-muted outline-none hover:bg-active hover:text-fg" title="Take their version">
                Theirs
              </button>
              <IconButton label="Open file to resolve by hand" size="icon-xs" onClick={() => open.file(f)}>
                <SquarePen />
              </IconButton>
            </>
          )}
        </span>
        <Tooltip label={group === "conflicts" && f.conflict ? `${WORDS["!"]} (${f.conflict})` : (WORDS[letter] ?? letter)} side="left">
          <span className="w-4 shrink-0 text-center">
            <Badge tone={TONE[letter] ?? "neutral"} className="!h-4 !w-4 justify-center !px-0">
              {letter}
            </Badge>
          </span>
        </Tooltip>
      </div>
    </ContextMenu>
  );
});

export function ChangeSection({ group, title, files, root, prefix, accent }: { group: Group; title: string; files: GitFile[]; root: string; prefix: string | undefined; accent?: boolean }) {
  const a = gitActions(root);
  const [open, setOpen] = useState(true);
  // A big untracked tree (a vendored folder that was never ignored) would mount thousands of rows on every poll.
  const [limit, setLimit] = useState(ROW_LIMIT);
  if (files.length === 0) return null;
  const paths = files.map((f) => f.path);

  const discardAll = async () => {
    const untracked = files.filter((f) => f.worktree === "?").length;
    const ok = await confirm({
      title: `Discard all ${files.length} change${files.length === 1 ? "" : "s"}?`,
      description: `${untracked ? `${untracked} untracked file${untracked === 1 ? " is" : "s are"} deleted from disk. ` : ""}Edits to tracked files are reverted. This cannot be undone.`,
      confirmLabel: "Discard all",
      danger: true,
    });
    if (ok) void a.discard(paths);
  };

  return (
    <Section
      title={<span className={cn(accent && "text-red")}>{title}</span>}
      count={files.length}
      open={open}
      onOpenChange={setOpen}
      actions={
        group === "staged" ? (
          <IconButton label="Unstage all" size="icon-xs" onClick={() => a.unstage(paths)}>
            <Minus />
          </IconButton>
        ) : group === "changes" ? (
          <>
            <IconButton label="Discard all changes" size="icon-xs" onClick={discardAll}>
              <RotateCcw />
            </IconButton>
            <IconButton label="Stage all" size="icon-xs" onClick={() => a.stage(paths)}>
              <Plus />
            </IconButton>
          </>
        ) : null
      }
    >
      <div role="tree" aria-label={title} className="pb-1">
        {files.slice(0, limit).map((f) => (
          <Row key={`${group}:${f.path}`} f={f} group={group} root={root} prefix={prefix} selectedId={null} />
        ))}
        {files.length > limit && (
          <button onClick={() => setLimit((n) => n + 500)} className="w-full px-3 py-1.5 text-left text-[11.5px] text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover">
            Show {Math.min(500, files.length - limit)} more ({files.length - limit} hidden)
          </button>
        )}
      </div>
    </Section>
  );
}

