import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Download, Trash2, Plus } from "lucide-react";
import { ago } from "@/lib/utils";
import { IconButton } from "@/components/ui/button";
import { Section } from "@/components/ui/misc";
import { ask, confirm } from "@/components/ui/dialogs";
import { gitActions, useBusy } from "./actions";
import { useStashes } from "./queries";

export async function promptStash(root: string): Promise<void> {
  const msg = await ask({ title: "Stash changes", label: "Message (optional)", placeholder: "WIP: pagination", description: "Saves your uncommitted changes, including new files, and restores a clean working tree.", confirmLabel: "Stash" });
  if (msg !== null) await gitActions(root).stashPush(msg);
}

export function Stashes({ root, count, hasChanges }: { root: string; count: number; hasChanges: boolean }) {
  const a = gitActions(root);
  const busy = useBusy((s) => !!s.busy.stash);
  const stashes = useStashes(root, count > 0);
  const list = stashes.data ?? [];
  const [open, setOpen] = useState(count > 0);
  const prev = useRef(count);
  // A stash was just made: show it, so the result of the action is visible.
  useEffect(() => {
    if (count > prev.current) setOpen(true);
    prev.current = count;
  }, [count]);
  // Nothing to stash and nothing stashed: no reason to take up a row.
  if (count === 0 && list.length === 0 && !hasChanges) return null;
  return (
    <Section
      title="Stashes"
      count={list.length || count}
      open={open}
      onOpenChange={setOpen}
      actions={
        <IconButton label="Stash changes…" size="icon-xs" onClick={() => promptStash(root)} disabled={busy}>
          <Plus />
        </IconButton>
      }
    >
      <div className="pb-1">
        {list.length === 0 && <div className="px-4 py-1.5 text-[11.5px] text-fg-faint">No stashes. Use + to set your changes aside.</div>}
        {list.map((s) => (
          <div key={s.ref} className="group/s flex h-[26px] items-center gap-2 px-2 text-[12.5px] hover:bg-hover">
            <Archive className="size-3.5 shrink-0 text-fg-faint" />
            <span className="min-w-0 flex-1 truncate" title={s.message}>
              {s.message.replace(/^(WIP on|On) [^:]+: /, "")}
            </span>
            <span className="shrink-0 text-[10.5px] text-fg-faint group-hover/s:hidden">{ago(s.date)}</span>
            <span className="hidden shrink-0 items-center group-hover/s:flex">
              <IconButton label="Apply (keep the stash)" size="icon-xs" onClick={() => a.stashOp("apply", s.index)}>
                <Download />
              </IconButton>
              <IconButton label="Pop (apply and drop)" size="icon-xs" onClick={() => a.stashOp("pop", s.index)}>
                <ArchiveRestore />
              </IconButton>
              <IconButton
                label="Drop"
                size="icon-xs"
                onClick={async () => {
                  if (await confirm({ title: "Drop this stash?", description: s.message, confirmLabel: "Drop", danger: true })) await a.stashOp("drop", s.index);
                }}
              >
                <Trash2 />
              </IconButton>
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}
