import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, CloudUpload, GitBranch, GitMerge, Loader2, RefreshCw, X } from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import { useGitStatus, useRoot } from "@/lib/queries";
import { IconButton, Button } from "@/components/ui/button";
import { DropdownMenu, Popover } from "@/components/ui/overlay";
import { Empty, Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { gitActions, useBusy } from "./actions";
import { BranchPicker } from "./BranchPicker";
import { ChangeSection } from "./ChangeList";
import { CommitBox } from "./CommitBox";
import { History } from "./History";
import { Stashes } from "./Stashes";
import { Worktrees } from "./Worktrees";
import { PublishDialog } from "./PublishDialog";
import { useGitUi } from "./ui";
import "./commands";

function SyncBar({ root, status, hasOrigin, folderName }: { root: string; status: NonNullable<ReturnType<typeof useGitStatus>["data"]>; hasOrigin: boolean; folderName: string }) {
  const a = gitActions(root);
  const [publishOpen, setPublishOpen] = useState(false);
  const busy = useBusy((s) => s.busy);
  const { branchPickerOpen, setBranchPicker } = useGitUi();
  const label = status.branch ?? (status.detached ? `${status.head?.slice(0, 7)} (detached)` : "no branch");
  const publish = !!status.branch && !status.upstream;
  // No origin at all: publishing means creating the repository first, not just setting an upstream.
  const create = publish && !hasOrigin;

  return (
    <div className="flex items-center gap-1 border-b border-line p-2">
      <Popover
        open={branchPickerOpen}
        onOpenChange={setBranchPicker}
        width={480}
        trigger={
          <button className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-raised px-2 text-left font-mono text-[12px] outline-none transition-colors hover:border-line-strong focus-visible:border-accent/60" aria-label={`Branch ${label}. Switch branch`}>
            {busy.checkout ? <Loader2 className="size-3.5 shrink-0 animate-spin-fast text-accent" /> : <GitBranch className="size-3.5 shrink-0 text-accent" />}
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <ChevronDown className="size-3 shrink-0 text-fg-faint" />
          </button>
        }
      >
        <BranchPicker root={root} status={status} onClose={() => setBranchPicker(false)} />
      </Popover>

      <IconButton label="Fetch from all remotes" size="icon" onClick={() => a.fetch()} disabled={!!busy.fetch}>
        <RefreshCw className={cn(busy.fetch && "animate-spin-fast")} />
      </IconButton>
      <div className="flex">
        <IconButton label={status.behind > 0 ? `Pull ${status.behind} commit${status.behind === 1 ? "" : "s"} (fast-forward only)` : "Pull (fast-forward only)"} size="icon" onClick={() => a.pull()} disabled={!!busy.pull || !status.upstream} className="relative w-8 rounded-r-none">
          {busy.pull ? <Loader2 className="animate-spin-fast" /> : <ArrowDown />}
          {status.behind > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-accent px-1 text-center font-mono text-[9px] leading-[14px] text-accent-fg">{status.behind}</span>}
        </IconButton>
        <DropdownMenu
          align="end"
          trigger={
            <button aria-label="More pull options" className="flex h-7 w-4 items-center justify-center rounded-r-md text-fg-faint outline-none hover:bg-hover hover:text-fg">
              <ChevronDown className="size-3" />
            </button>
          }
          entries={[
            { label: "Pull (fast-forward only)", onSelect: () => a.pull("ff-only") },
            { label: "Pull with rebase", onSelect: () => a.pull("rebase") },
            { label: "Pull with merge", onSelect: () => a.pull("merge") },
          ]}
        />
      </div>
      <IconButton
        label={create ? "Publish to GitHub" : publish ? "Publish branch to origin" : status.ahead > 0 ? `Push ${status.ahead} commit${status.ahead === 1 ? "" : "s"}` : "Push"}
        size="icon"
        onClick={() => (create ? setPublishOpen(true) : a.push(publish ? { setUpstream: true, branch: status.branch ?? undefined } : {}))}
        disabled={!!busy.push || (!publish && status.ahead === 0 && !!status.upstream)}
        className="relative"
      >
        {busy.push ? <Loader2 className="animate-spin-fast" /> : publish ? <CloudUpload /> : <ArrowUp />}
        {status.ahead > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-accent px-1 text-center font-mono text-[9px] leading-[14px] text-accent-fg">{status.ahead}</span>}
      </IconButton>
      <PublishDialog root={root} defaultName={folderName} open={publishOpen} onOpenChange={setPublishOpen} />
    </div>
  );
}

export function GitSidebar() {
  const { root, repo } = useWorkspace();
  const status = useGitStatus(root);
  const rootInfo = useRoot(root);
  const a = gitActions(root);
  const busy = useBusy((s) => s.busy);
  const [dismissed, setDismissed] = useState(false);
  const operation = status.data?.operation ?? null;
  // A new merge/rebase is news again, even if the last one's banner was dismissed.
  useEffect(() => setDismissed(false), [operation]);

  if (repo && !repo.isRepo && repo.problem) {
    // Git failed for a reason other than "no repository": offering to initialize would hide the real problem.
    return (
      <div className="flex h-full flex-col">
        <Empty
          icon={<GitBranch />}
          title="Git is not working here"
          hint={<span className="whitespace-pre-wrap break-words">{repo.problem}</span>}
          action={
            repo.untrusted ? (
              <Button variant="primary" size="md" onClick={() => a.trust()} disabled={!!busy.trust}>
                {busy.trust ? <Loader2 className="animate-spin-fast" /> : null} Trust this folder
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  if (repo && !repo.isRepo) {
    return (
      <div className="flex h-full flex-col">
        <Empty
          icon={<GitBranch />}
          title="Not a git repository"
          hint="Initialize one to track changes, commit, and let agents work in isolated worktrees."
          action={
            <Button variant="primary" size="md" onClick={() => a.init()} disabled={!!busy.init}>
              {busy.init ? <Loader2 className="animate-spin-fast" /> : null} Initialize repository
            </Button>
          }
        />
      </div>
    );
  }

  const s = status.data;
  if (!s) {
    return (
      <div className="space-y-2 p-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-7" />
        ))}
        {status.error && <div className="text-xs text-red">{(status.error as Error).message}</div>}
      </div>
    );
  }

  const conflicts = s.files.filter((f) => f.conflict);
  const staged = s.files.filter((f) => !f.conflict && f.index !== "." && f.index !== "?");
  const changes = s.files.filter((f) => !f.conflict && f.worktree !== ".");
  const prefix = repo?.prefix;

  return (
    <div className="flex h-full flex-col" aria-label="Source control">
      <SyncBar root={root} status={s} hasOrigin={!!repo?.remotes?.some((r) => r.name === "origin")} folderName={(rootInfo.data?.root.dir ?? "").split(/[\\/]/).filter(Boolean).pop()?.replace(/[^A-Za-z0-9._-]+/g, "-") ?? ""} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {s.operation && !dismissed && (
          <div role="status" className="m-2 flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-2 text-[12px] leading-snug">
            <GitMerge className="mt-0.5 size-3.5 shrink-0 text-amber" />
            <div className="min-w-0 flex-1">
              <div className="font-medium first-letter:uppercase">{s.operation} in progress</div>
              <div className="text-fg-muted">{conflicts.length > 0 ? `Resolve ${conflicts.length} conflicted file${conflicts.length === 1 ? "" : "s"}, then commit.` : "All conflicts are resolved. Commit to finish."}</div>
              <Button variant="outline" size="xs" className="mt-1.5" disabled={!!busy.merge} onClick={() => a.abort(s.operation!)}>
                {busy.merge ? <Loader2 className="animate-spin-fast" /> : null} Abort {s.operation}
              </Button>
            </div>
            <button aria-label="Dismiss" onClick={() => setDismissed(true)} className="rounded p-0.5 text-fg-faint hover:bg-active hover:text-fg">
              <X className="size-3" />
            </button>
          </div>
        )}
        <CommitBox root={root} status={s} repo={repo} />
        <ChangeSection group="conflicts" title="Merge conflicts" files={conflicts} root={root} prefix={prefix} accent />
        <ChangeSection group="staged" title="Staged changes" files={staged} root={root} prefix={prefix} />
        <ChangeSection group="changes" title="Changes" files={changes} root={root} prefix={prefix} />
        {s.files.length === 0 && (
          <div className="px-4 py-5 text-center text-xs text-fg-muted animate-slide-up">
            Working tree clean.
            {s.ahead > 0 && <div className="mt-1 text-fg-faint">{s.ahead} commit{s.ahead === 1 ? "" : "s"} to push.</div>}
          </div>
        )}
        <Stashes root={root} count={s.stashCount} hasChanges={s.files.length > 0} />
        <Worktrees root={root} currentDir={rootInfo.data?.root.dir} />
        <History root={root} headSha={s.head} />
      </div>
    </div>
  );
}
