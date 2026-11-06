import { useState } from "react";
import { Brain, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { Badge, Empty, Spinner } from "@/components/ui/misc";
import { useWorkspace } from "@/lib/workspace";
import { useMemory, useMemoryActions, type MemoryRule } from "./data";

function Row({ rule, onSave, onDelete }: { rule: MemoryRule; onSave: (text: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.text);
  const commit = () => {
    if (text.trim() && text.trim() !== rule.text) onSave(text);
    setEditing(false);
  };
  return (
    <li className="group flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
      {editing ? (
        <>
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? commit() : e.key === "Escape" && setEditing(false))} aria-label="Rule text" />
          <IconButton label="Save" onClick={commit}>
            <Check />
          </IconButton>
          <IconButton
            label="Cancel"
            onClick={() => {
              setText(rule.text);
              setEditing(false);
            }}
          >
            <X />
          </IconButton>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-[13px] leading-snug">{rule.text}</span>
          <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <IconButton label="Edit" onClick={() => setEditing(true)}>
              <Pencil />
            </IconButton>
            <IconButton label="Delete" onClick={onDelete}>
              <Trash2 />
            </IconButton>
          </span>
        </>
      )}
    </li>
  );
}

/** Project memory: the rules every engine reads from AGENTS.md (and CLAUDE.md). The file is the data; this tab is a lens over it. */
export function MemoryTab() {
  const { root } = useWorkspace();
  const q = useMemory(root);
  const act = useMemoryActions(root);
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    act.add.mutate(draft, { onSuccess: () => setDraft("") });
  };
  return (
    <div className="h-full overflow-auto bg-bg">
      <div className="mx-auto flex max-w-[720px] flex-col gap-4 p-6">
        <div className="flex items-center gap-2">
          <Brain className="size-4 text-accent" />
          <h1 className="text-[15px] font-semibold">Project memory</h1>
        </div>
        <p className="text-xs leading-relaxed text-fg-muted">
          Rules for this project, written into a clearly marked block of AGENTS.md and CLAUDE.md so claude, codex and cursor all read them. Anything you wrote outside that block is never touched.
        </p>
        <div className="flex gap-2">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Add a rule, e.g. We use bun, not npm." aria-label="New rule" />
          <Button variant="primary" onClick={add} disabled={!draft.trim() || act.add.isPending}>
            <Plus /> Add
          </Button>
        </div>
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <div className="text-xs text-red">{(q.error as Error).message}</div>
        ) : !q.data?.rules.length ? (
          <Empty icon={<Brain />} title="No rules yet" hint="Tell an agent how this project works (“we use bun, not npm”) and you will be offered to save it here." className="rounded-xl border border-dashed border-line" />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {q.data.rules.map((r) => (
              <Row key={r.id} rule={r} onSave={(text) => act.edit.mutate({ id: r.id, text })} onDelete={() => act.remove.mutate(r.id)} />
            ))}
          </ul>
        )}
        {q.data && (
          <div className="flex flex-wrap gap-2 text-[11px] text-fg-faint">
            {q.data.files.map((f) => (
              <Badge key={f.path} tone={f.managed ? "green" : "neutral"} title={f.note ?? undefined}>
                {f.path}: {f.note ? f.note : f.managed ? "in sync" : f.exists ? "yours" : "not created"}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
