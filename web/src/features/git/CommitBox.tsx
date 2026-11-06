import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Copy, GitCommitHorizontal, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { GitStatus, RepoInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/overlay";
import { Checkbox } from "@/components/ui/form";
import { formatCombo } from "@/lib/hooks";
import { commitDraftKey, drafts } from "@/lib/drafts";
import { gitActions, useBusy } from "./actions";
import { useGitUi } from "./ui";

/** The commit message box with its guard rails: what is staged, who you are, and why Commit is disabled. */
export function CommitBox({ root, status, repo }: { root: string; status: GitStatus; repo: RepoInfo | undefined }) {
  const a = gitActions(root);
  const busy = useBusy((s) => s.busy);
  const focusTick = useGitUi((s) => s.focusCommit);
  // The message survives switching away, a reload and the panel unmounting. An amend's message is the last commit's, not a draft.
  const dkey = commitDraftKey(root);
  const [message, setMessage] = useState(() => drafts.get(dkey));
  const [amend, setAmend] = useState(false);
  useEffect(() => {
    setMessage(drafts.get(dkey));
    setAmend(false);
  }, [dkey]);
  const edit = (v: string) => {
    setMessage(v);
    if (!amend) drafts.set(dkey, v);
  };
  const reset = () => {
    setMessage("");
    setAmend(false);
    drafts.set(dkey, "");
  };
  const [done, setDone] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  const staged = status.files.filter((f) => f.index !== "." && f.index !== "U" && !f.conflict).length;
  const unstaged = status.files.filter((f) => f.worktree !== "." && !f.conflict).length;
  const conflicts = status.files.filter((f) => f.conflict).length;
  const merging = status.operation === "merge";
  const subject = message.split("\n")[0] ?? "";

  useEffect(() => {
    if (focusTick) ta.current?.focus();
  }, [focusTick]);

  // Auto-grow up to a limit; beyond it the box scrolls.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [message]);

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && !message.trim()) {
      const last = await a.lastCommit();
      if (last) setMessage(last.body ? `${last.subject}\n\n${last.body}` : last.subject);
    }
  };

  let reason: string | null = null;
  if (conflicts > 0) reason = `Resolve ${conflicts} conflicted file${conflicts === 1 ? "" : "s"} first`;
  else if (staged === 0 && !amend && !merging) reason = unstaged > 0 ? "Nothing staged. Stage files, or use Stage all & commit" : "Nothing to commit";
  else if (!message.trim() && !amend) reason = "Write a commit message";

  const doCommit = async (opts: { stageAll?: boolean; push?: boolean } = {}) => {
    if (opts.stageAll) {
      const ok = await a.stage(status.files.filter((f) => !f.conflict).map((f) => f.path));
      if (!ok) return;
    }
    const r = await a.commit(message, { amend });
    if (!r) return;
    reset();
    setDone(r.sha.slice(0, 7));
    toast.success(`Committed ${r.sha.slice(0, 7)}`, { description: r.summary });
    setTimeout(() => setDone(null), 1600);
    if (opts.push) await a.push(status.upstream ? {} : { setUpstream: true, branch: status.branch ?? undefined });
  };

  const identityMissing = repo?.identity && (!repo.identity.name || !repo.identity.email);
  const committing = !!busy.commit;
  const canCommit = !reason && !committing;

  return (
    <div className="flex flex-col gap-2 border-b border-line p-2">
      {identityMissing && (
        <div role="alert" className="flex gap-2 rounded-md border border-amber/30 bg-amber/10 p-2 text-[11.5px] leading-snug text-fg">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber" />
          <div className="min-w-0">
            Git does not know who you are, so commits will fail. Set it once:
            <pre className="mt-1 select-all overflow-x-auto rounded bg-raised px-2 py-1 font-mono text-[10.5px] text-fg-muted">{`git config --global user.name "Your Name"\ngit config --global user.email "you@example.com"`}</pre>
          </div>
        </div>
      )}
      <div className="relative">
        <textarea
          ref={ta}
          value={message}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              // A shortcut that silently does nothing is worse than one that says why.
              if (canCommit) void doCommit();
              else if (reason) toast.info(reason);
            }
          }}
          rows={2}
          spellCheck
          aria-label="Commit message"
          placeholder={merging ? "Merge commit message" : `Message (${formatCombo({ key: "Enter", mod: true })} to commit)`}
          className="w-full resize-none rounded-md border border-line bg-raised px-2.5 py-2 text-[13px] leading-snug text-fg outline-none transition-colors placeholder:text-fg-faint hover:border-line-strong focus:border-accent/70 focus:bg-panel"
        />
        {subject.length > 0 && (
          <span title="Subject line length. 50 is conventional, 72 is the hard wrap." className={cn("pointer-events-none absolute bottom-1.5 right-2 font-mono text-[10px]", subject.length > 72 ? "text-red" : subject.length > 50 ? "text-amber" : "text-fg-faint")}>
            {subject.length}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1">
          <Button variant="primary" size="md" disabled={!canCommit} title={reason ?? undefined} onClick={() => doCommit()} className="h-8 min-w-0 flex-1 rounded-r-none">
            {committing ? <Loader2 className="animate-spin-fast" /> : done ? <Check className="animate-pop" /> : <GitCommitHorizontal />}
            <span className="truncate">{committing ? "Committing…" : done ? `Committed ${done}` : amend ? "Amend commit" : staged > 0 ? `Commit ${staged} file${staged === 1 ? "" : "s"}` : "Commit"}</span>
          </Button>
          <DropdownMenu
            align="end"
            trigger={
              <Button variant="primary" size="md" aria-label="More commit actions" className="h-8 w-7 rounded-l-none border-l border-accent-fg/20 px-0">
                <ChevronDown />
              </Button>
            }
            entries={[
              { label: "Commit & push", disabled: !canCommit, onSelect: () => doCommit({ push: true }) },
              { label: "Stage all & commit", disabled: !message.trim() || conflicts > 0 || committing || unstaged + staged === 0, onSelect: () => doCommit({ stageAll: true }) },
              { label: "Commit without running hooks", disabled: !canCommit, onSelect: async () => {
                  const r = await a.commit(message, { amend, noVerify: true });
                  if (r) {
                    reset();
                    toast.success(`Committed ${r.sha.slice(0, 7)}`, { description: r.summary });
                  }
                } },
              { separator: true },
              { label: "Copy message", icon: <Copy />, disabled: !message, onSelect: () => navigator.clipboard.writeText(message) },
            ]}
          />
        </div>
      </div>
      <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-fg-muted select-none">
        <Checkbox checked={amend} onChange={toggleAmend} label="Amend the last commit" />
        Amend last commit
      </label>
      {reason && (
        <div className="text-[11.5px] leading-snug text-fg-faint" role="status">
          {reason}
        </div>
      )}
    </div>
  );
}
