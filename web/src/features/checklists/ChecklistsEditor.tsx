import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Plus, RotateCcw, Save, Trash2, Undo2, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { ask, confirm } from "@/components/ui/dialogs";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { type CatalogAdminEntry, type ItemKind, type Severity, useCatalogActions, useChecklistAdmin } from "./data";
import { blankForm, blankItem, checkFor, formProblem, idFrom, type ItemForm, moveItem, sameForm, toDefinition, toForm, type ChecklistForm } from "./editor-logic";

const KIND_LABEL: Record<ItemKind, string> = { auto: "Automatic check", agent: "Agent judges", manual: "A person decides" };
const SEVERITY_LABEL: Record<Severity, string> = { required: "Required", recommended: "Recommended" };
const ID_RULE = /^[a-z][a-z0-9-]{1,39}$/;

/** One item: its text, id, category, severity, kind, the check when it is automatic, and its hint. */
function ItemRow({ item, n, count, checks, onChange, onMove, onRemove }: { item: ItemForm; n: number; count: number; checks: string[]; onChange: (patch: Partial<ItemForm>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
  const auto = item.kind === "auto";
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3" data-checklist-item={item.id || n + 1}>
      <div className="flex items-center gap-1.5">
        <span className="w-5 shrink-0 text-right font-mono text-xs text-fg-faint">{n + 1}</span>
        <Input
          value={item.text}
          placeholder="What must be true"
          aria-label={`Item ${n + 1} text`}
          onChange={(e) => onChange({ text: e.target.value, ...(item.id ? {} : { id: idFrom(e.target.value) }) })}
          className="min-w-0 flex-1"
        />
        <IconButton label={`Move item ${n + 1} up`} size="icon-sm" disabled={n === 0} onClick={() => onMove(-1)}>
          <ArrowUp />
        </IconButton>
        <IconButton label={`Move item ${n + 1} down`} size="icon-sm" disabled={n === count - 1} onClick={() => onMove(1)}>
          <ArrowDown />
        </IconButton>
        <IconButton label={`Remove item ${n + 1}`} size="icon-sm" onClick={onRemove}>
          <X />
        </IconButton>
      </div>
      <div className="@container pl-7">
        <div className="grid grid-cols-1 gap-2 @[28rem]:grid-cols-2 @[44rem]:grid-cols-5">
          <Field label="Id">
            <Input value={item.id} onChange={(e) => onChange({ id: e.target.value })} className="font-mono text-xs" spellCheck={false} aria-label={`Item ${n + 1} id`} />
          </Field>
          <Field label="Category">
            <Input value={item.category} onChange={(e) => onChange({ category: e.target.value })} maxLength={40} aria-label={`Item ${n + 1} category`} />
          </Field>
          <Field label="Severity">
            <Select
              size="sm"
              value={item.severity}
              onChange={(v) => onChange({ severity: v as Severity })}
              options={(Object.keys(SEVERITY_LABEL) as Severity[]).map((s) => ({ value: s, label: SEVERITY_LABEL[s] }))}
              aria-label={`Item ${n + 1} severity`}
            />
          </Field>
          <Field label="Kind">
            <Select
              size="sm"
              value={item.kind}
              onChange={(v) => onChange({ kind: v as ItemKind, check: checkFor(v as ItemKind, item.check) })}
              options={(Object.keys(KIND_LABEL) as ItemKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
              aria-label={`Item ${n + 1} kind`}
            />
          </Field>
          <Field label="Check" hint={auto ? undefined : "Only an automatic item runs a check."}>
            <Select
              size="sm"
              value={item.check}
              onChange={(v) => onChange({ check: v })}
              disabled={!auto}
              placeholder="Choose a check"
              options={checks.map((c) => ({ value: c, label: c }))}
              aria-label={`Item ${n + 1} check`}
            />
          </Field>
        </div>
      </div>
      <Field label="Hint" className="pl-7">
        <Textarea value={item.hint} onChange={(e) => onChange({ hint: e.target.value })} maxLength={500} className="h-14 text-xs" aria-label={`Item ${n + 1} hint`} placeholder="What to do when it does not pass" />
      </Field>
    </li>
  );
}

/**
 * The checklists of the catalog: the built-in ones (each one editable, and "reset to default" once it is modified), the
 * custom ones, and the new ones. Title, summary and tags on top; the items below, reordered with the arrows. Mounted by the
 * Settings page and reachable from the checklist panel.
 */
export function ChecklistsEditor() {
  const admin = useChecklistAdmin();
  const actions = useCatalogActions();
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<ChecklistForm | null>(null);

  const list: CatalogAdminEntry[] = admin.data?.checklists ?? [];
  const checks = admin.data?.checks ?? [];
  const current = list.find((c) => c.id === sel) ?? null;
  const original = current ? toForm(current) : null;
  const dirty = !!form && (form.isNew || !original || !sameForm(form, original));
  const problem = form ? formProblem(form) : null;
  const busy = actions.save.isPending || actions.create.isPending || actions.reset.isPending || actions.remove.isPending;

  // Open the first checklist once, when the list first arrives. Later selections come from the list's own actions.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !list.length) return;
    opened.current = true;
    setSel(list[0]!.id);
    setForm(toForm(list[0]!));
  }, [list]);

  const select = async (c: CatalogAdminEntry) => {
    if (form && dirty && !(await confirm({ title: "Discard unsaved changes?", description: `Your edits to "${form.title || form.id}" have not been saved.`, confirmLabel: "Discard", danger: true }))) return;
    setSel(c.id);
    setForm(toForm(c));
  };

  const newChecklist = async () => {
    if (form && dirty && !(await confirm({ title: "Discard unsaved changes?", confirmLabel: "Discard", danger: true }))) return;
    setSel(null);
    setForm(blankForm());
  };

  const set = (patch: Partial<ChecklistForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setItem = (n: number, patch: Partial<ItemForm>) => set({ items: (form?.items ?? []).map((i, j) => (j === n ? { ...i, ...patch } : i)) });

  const save = () => {
    if (!form || problem) return;
    const def = toDefinition(form);
    if (form.isNew) {
      actions.create.mutate({ def }, {
        onSuccess: (r) => {
          setSel(r.checklist.id);
          setForm(toForm(r.checklist));
        },
      });
    } else {
      actions.save.mutate({ id: form.id, def }, { onSuccess: (r) => setForm(toForm(r.checklist)) });
    }
  };

  const fork = async () => {
    if (!form || problem) return;
    const id = await ask({
      title: "Fork this checklist",
      description: "A copy under a new id, with its items. It is yours, and the original stays as it is.",
      label: "New id",
      initial: `${form.id}-copy`.slice(0, 40),
      confirmLabel: "Fork",
      validate: (v) => (ID_RULE.test(v.trim()) ? (list.some((c) => c.id === v.trim()) ? `"${v.trim()}" already exists.` : null) : "2 to 40 lowercase letters, digits or dashes, starting with a letter."),
    });
    if (!id) return;
    const def = { ...toDefinition(form), id: id.trim(), title: `${form.title.trim() || form.id} (copy)`.slice(0, 60) };
    actions.create.mutate({ def }, {
      onSuccess: (r) => {
        setSel(r.checklist.id);
        setForm(toForm(r.checklist));
      },
    });
  };

  const reset = async () => {
    if (!current) return;
    if (!(await confirm({ title: `Reset "${current.title}" to the default?`, description: "Your changes to this checklist are replaced by the version that shipped with trb. Attached projects keep their answers.", confirmLabel: "Reset", danger: true }))) return;
    actions.reset.mutate(current.id, { onSuccess: (r) => setForm(toForm(r.checklist)) });
  };

  const remove = async () => {
    if (!form || form.isNew || !current) return;
    if (!(await confirm({ title: `Delete "${current.title}"?`, description: "Projects that had it keep their file, but it stops being offered. This cannot be undone.", confirmLabel: "Delete", danger: true }))) return;
    // The next one in the list that is not the deleted one (the list refetches after the delete; this picks from the old copy).
    const next = list.find((c) => c.id !== current.id) ?? null;
    actions.remove.mutate(current.id, {
      onSuccess: () => {
        setSel(next?.id ?? null);
        setForm(next ? toForm(next) : null);
      },
    });
  };

  if (admin.isLoading) return <Skeleton className="h-64" />;

  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-6 @[38rem]:grid-cols-[260px_minmax(0,1fr)]" data-checklists-editor>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1" role="list" aria-label="Checklists">
            {list.map((c) => (
              <button
                key={c.id}
                role="listitem"
                data-checklist-select={c.id}
                onClick={() => void select(c)}
                aria-current={sel === c.id && !form?.isNew ? "true" : undefined}
                className={cn("flex min-w-0 flex-col gap-1 rounded-lg border px-2 py-1.5 text-left outline-none transition-colors", sel === c.id && !form?.isNew ? "border-line-strong bg-accent-soft" : "border-line hover:bg-hover")}
              >
                <span className="block truncate text-sm font-medium">{c.title}</span>
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  <span className="truncate font-mono text-xs text-fg-faint">{c.id}</span>
                  {c.builtin ? <Badge>built-in</Badge> : <Badge>custom</Badge>}
                  {c.modified && <Badge>modified</Badge>}
                </span>
              </button>
            ))}
            {form?.isNew && (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong px-2 py-1.5 text-sm">
                <Plus className="size-4 text-fg-muted" aria-hidden /> <span className="truncate">{form.title || "New checklist"}</span> <Badge>new</Badge>
              </div>
            )}
          </div>
          <Button size="md" onClick={() => void newChecklist()} data-checklist-add>
            <Plus /> New checklist
          </Button>
          <p className="text-xs leading-relaxed text-fg-faint">Stored in your trb home (checklists.json), never in a project. A built-in edit replaces the shipped one until you reset it.</p>
        </div>

        <div className="min-w-0">
          {!form && <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-fg-muted">No checklists. Add one.</div>}
          {form && (
            <div className="flex min-w-0 flex-col gap-4" data-checklist-editor>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                <Field label="Title">
                  <Input value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={60} aria-label="Checklist title" data-checklist-title />
                </Field>
                <Field label="Id" hint={form.isNew ? "Lowercase, dashes. It cannot change later." : "Fixed. Fork to make a new one."}>
                  <Input value={form.id} onChange={(e) => set({ id: e.target.value })} disabled={!form.isNew} className="font-mono text-xs" spellCheck={false} aria-label="Checklist id" />
                </Field>
              </div>
              <Field label="Summary">
                <Input value={form.summary} onChange={(e) => set({ summary: e.target.value })} maxLength={200} aria-label="Checklist summary" />
              </Field>
              <Field label="Applies to" hint="Tags, comma-separated: marketing, saas, mobile, api. A new workspace from a recipe with one of these tags starts with this checklist.">
                <Input value={form.appliesTo} onChange={(e) => set({ appliesTo: e.target.value })} className="font-mono text-xs" spellCheck={false} aria-label="Applies to tags" />
              </Field>

              <section className="flex flex-col gap-2" aria-label="Items">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-label text-fg-muted">Items ({form.items.length})</span>
                  <Button size="xs" variant="ghost" disabled={form.items.length >= (admin.data?.maxItems ?? 100)} onClick={() => set({ items: [...form.items, blankItem()] })}>
                    <Plus /> Add item
                  </Button>
                </div>
                <ul className="flex flex-col gap-2">
                  {form.items.map((item, n) => (
                    <ItemRow
                      key={item.key}
                      item={item}
                      n={n}
                      count={form.items.length}
                      checks={checks}
                      onChange={(patch) => setItem(n, patch.kind !== undefined ? { ...patch, check: checkFor(patch.kind, item.check) } : patch)}
                      onMove={(dir) => set({ items: moveItem(form.items, n, dir) })}
                      onRemove={() => set({ items: form.items.filter((_, j) => j !== n) })}
                    />
                  ))}
                </ul>
              </section>

              <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line bg-panel/95 px-1 py-3 backdrop-blur [&>button]:shrink-0 [&>button]:whitespace-nowrap">
                <Button variant="primary" size="md" disabled={busy || !dirty || !!problem} onClick={save} data-checklist-save title={problem ?? undefined}>
                  <Save /> {form.isNew ? "Create checklist" : "Save changes"}
                </Button>
                {dirty && !form.isNew && original && (
                  <Button size="md" variant="ghost" onClick={() => setForm(original)}>
                    <Undo2 /> Revert
                  </Button>
                )}
                {problem && dirty && <span className="text-xs text-amber">{problem}</span>}
                <span className="flex-1" />
                {!form.isNew && (
                  <>
                    <Button size="md" variant="ghost" onClick={() => void fork()} disabled={busy}>
                      <Copy /> Fork
                    </Button>
                    {current?.modified && (
                      <Button size="md" variant="ghost" onClick={() => void reset()} data-checklist-reset title="Put this checklist back to what shipped with trb">
                        <RotateCcw /> Reset to default
                      </Button>
                    )}
                    {current && !current.builtin && (
                      <Button size="md" variant="dangerGhost" onClick={() => void remove()} data-checklist-delete>
                        <Trash2 /> Delete
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
