import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, Cloud, GitBranch, GitMerge, Plus, Trash2 } from "lucide-react";
import type { GitBranch as Branch, GitStatus } from "@/lib/types";
import { cn, ago } from "@/lib/utils";
import { IconButton } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { ask, confirm } from "@/components/ui/dialogs";
import { gitActions, useBusy } from "./actions";
import { useBranches } from "./queries";

const VALID = (n: string) => (/^(?!-)[^\s~^:?*[\\]+$/.test(n) && !n.includes("..") && !n.endsWith("/") && !n.endsWith(".lock") ? null : "Not a valid branch name");

export async function promptNewBranch(root: string, from?: string, title = "Create branch"): Promise<void> {
  const name = await ask({ title, label: "Branch name", placeholder: "feature/short-description", description: from ? `New branch starts at ${from}.` : "New branch starts at the current commit and is checked out.", confirmLabel: "Create & switch", validate: (v) => (v.trim() ? VALID(v.trim()) : "Name is required") });
  if (name) await gitActions(root).createBranch(name.trim(), from);
}

/** The branch list popover: filter, switch, create, merge into current, delete. */
export function BranchPicker({ root, status, onClose }: { root: string; status: GitStatus; onClose: () => void }) {
  const a = gitActions(root);
  const branches = useBranches(root);
  const busy = useBusy((s) => s.busy);
  const [q, setQ] = useState("");

  const { local, remote } = useMemo(() => {
    const f = (b: Branch) => !q || b.name.toLowerCase().includes(q.toLowerCase());
    const all = branches.data ?? [];
    // A remote branch that already has a local counterpart is noise in this list.
    const locals = new Set(all.filter((b) => !b.remote).map((b) => b.name));
    return { local: all.filter((b) => !b.remote && f(b)), remote: all.filter((b) => b.remote && f(b) && !locals.has(b.name.replace(/^[^/]+\//, ""))) };
  }, [branches.data, q]);

  const exact = (branches.data ?? []).some((b) => b.name === q.trim());
  const current = status.branch;

  const pick = async (b: Branch) => {
    if (b.current) return onClose();
    onClose();
    await a.checkout(b.name, b.remote);
  };

  const remove = async (b: Branch) => {
    const ok = await confirm({ title: `Delete branch ${b.name}?`, description: b.ahead > 0 || b.upstream === null ? "If it has commits that are not merged anywhere, git will refuse unless you force the delete. You can force it in the next step." : undefined, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    const done = await a.deleteBranch(b.name);
    if (!done) {
      const force = await confirm({ title: `Force delete ${b.name}?`, description: "It has commits that are not merged. They will be unreachable (recoverable only via the reflog).", confirmLabel: "Force delete", danger: true });
      if (force) await a.deleteBranch(b.name, true);
    }
  };

  const row = (b: Branch) => (
    <div key={b.name} role="option" aria-selected={b.current} tabIndex={0} onClick={() => pick(b)} onKeyDown={(e) => e.key === "Enter" && pick(b)} className="group/b flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[12.5px] outline-none hover:bg-active focus-visible:bg-active">
      {b.current ? <Check className="size-3.5 shrink-0 text-accent" /> : b.remote ? <Cloud className="size-3.5 shrink-0 text-violet" /> : <GitBranch className="size-3.5 shrink-0 text-fg-faint" />}
      <span className={cn("min-w-0 truncate", b.current && "font-medium")}>{b.name}</span>
      {(b.ahead > 0 || b.behind > 0) && (
        <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-fg-faint">
          {b.ahead > 0 && (
            <span className="flex items-center">
              <ArrowUp className="size-2.5" />
              {b.ahead}
            </span>
          )}
          {b.behind > 0 && (
            <span className="flex items-center">
              <ArrowDown className="size-2.5" />
              {b.behind}
            </span>
          )}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-right text-[11px] text-fg-faint">{b.subject}</span>
      <span className="shrink-0 text-[10.5px] text-fg-faint group-hover/b:hidden">{ago(b.date)}</span>
      {!b.current && !b.remote && (
        <span className="hidden shrink-0 items-center group-hover/b:flex" onClick={(e) => e.stopPropagation()}>
          <IconButton
            label={`Merge ${b.name} into ${current ?? "HEAD"}`}
            size="icon-xs"
            onClick={async () => {
              onClose();
              await a.merge(b.name);
            }}
          >
            <GitMerge />
          </IconButton>
          <IconButton label="Delete branch" size="icon-xs" variant="dangerGhost" onClick={() => remove(b)}>
            <Trash2 />
          </IconButton>
        </span>
      )}
    </div>
  );

  return (
    <div className="flex max-h-[min(70vh,460px)] w-[min(92vw,460px)] flex-col">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Switch branch or create one…" aria-label="Filter branches" className="mb-1 h-8 w-full rounded-md border border-line bg-raised px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-accent/70" />
      <div role="listbox" aria-label="Branches" className="min-h-0 flex-1 overflow-y-auto">
        {branches.isLoading && (
          <div className="flex justify-center p-4">
            <Spinner />
          </div>
        )}
        {local.length > 0 && <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">Local</div>}
        {local.map(row)}
        {remote.length > 0 && <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">Remote</div>}
        {remote.map(row)}
        {!branches.isLoading && local.length + remote.length === 0 && <div className="p-4 text-center text-xs text-fg-faint">No matching branches</div>}
      </div>
      <div className="mt-1 border-t border-line pt-1">
        {q.trim() && !exact && VALID(q.trim()) === null && (
          <button
            onClick={async () => {
              onClose();
              await a.createBranch(q.trim());
            }}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] outline-none hover:bg-active"
          >
            <Plus className="size-3.5 text-accent" />
            Create branch <span className="font-mono text-accent">{q.trim()}</span> {busy.checkout && <Spinner />}
          </button>
        )}
        <button
          onClick={() => {
            onClose();
            void promptNewBranch(root);
          }}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-fg-muted outline-none hover:bg-active hover:text-fg"
        >
          <Plus className="size-3.5" /> Create new branch…
        </button>
      </div>
    </div>
  );
}
