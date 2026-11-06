import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Copy, Plus, RotateCcw, Save, Trash2, Undo2 } from "lucide-react";
import { del, post, put } from "@/lib/api";
import { Button, IconButton } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Badge, SegTabs, Skeleton } from "@/components/ui/misc";
import { Markdown } from "@/features/agent/Markdown";
import { cn } from "@/lib/utils";
import { PageShell } from "../settings/shared";
import { SYSTEMS_KEY, useSystems } from "./data";
import { blankForm, duplicateForm, formProblem, moveId, sameForm, toForm, toSystem, type SystemForm, type SystemList, type SystemView } from "./logic";
import { ColorStrip, TokenPanel } from "./Swatches";

type Pane = "design" | "tokens" | "preview";

function Editor({ form, setForm, original, saved, onSave, onRevert, onDelete, onDuplicate, onReset, saving, canReset, modified }: { form: SystemForm; setForm: (f: SystemForm) => void; original: SystemForm | null; saved: SystemView | null; onSave: () => void; onRevert: () => void; onDelete: () => void; onDuplicate: () => void; onReset: () => void; saving: boolean; canReset: boolean; modified: boolean }) {
  const [pane, setPane] = useState<Pane>("design");
  const set = <K extends keyof SystemForm>(k: K, v: SystemForm[K]) => setForm({ ...form, [k]: v });
  const dirty = !original || !sameForm(form, original);
  const problem = formProblem(form);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-system-editor>
      <div className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-3">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={60} aria-label="Design system name" data-system-name />
        </Field>
        <Field label="Description" hint="Shown in New app and the Design tab.">
          <Input value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={300} aria-label="Design system description" />
        </Field>
      </div>
      <SegTabs<Pane>
        value={pane}
        onChange={setPane}
        items={[
          { value: "design", label: "DESIGN.md" },
          { value: "tokens", label: "tokens.css" },
          { value: "preview", label: "Preview" },
        ]}
        className="w-[300px]"
      />
      {pane === "design" && <Textarea value={form.design} onChange={(e) => set("design", e.target.value)} className="h-[52vh] font-mono text-[12px] leading-relaxed" spellCheck={false} aria-label="DESIGN.md" data-system-design />}
      {pane === "tokens" && (
        <div className="flex flex-col gap-1.5">
          <Textarea value={form.tokens} onChange={(e) => set("tokens", e.target.value)} className="h-[52vh] font-mono text-[12px] leading-relaxed" spellCheck={false} aria-label="tokens.css" data-system-tokens />
          <p className="text-[11px] text-fg-faint">
            Plain CSS custom properties: <span className="font-mono">:root</span> for light, a dark scope (<span className="font-mono">prefers-color-scheme: dark</span> or <span className="font-mono">[data-theme="dark"]</span>). Keep the contract names (<span className="font-mono">--color-*</span>, <span className="font-mono">--font-*</span>, <span className="font-mono">--text-*</span>, <span className="font-mono">--space-*</span>, <span className="font-mono">--radius-*</span>, <span className="font-mono">--shadow-*</span>) so systems stay swappable.
          </p>
        </div>
      )}
      {pane === "preview" && (
        <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-5 rounded-lg border border-line p-4">
          <div>
            {saved ? <TokenPanel summary={saved.summary} path="tokens.css" /> : <p className="text-[12px] text-fg-muted">Save to see the swatches.</p>}
            {saved && dirty && <p className="mt-2 text-[11px] text-amber">Swatches show the saved tokens.css.</p>}
          </div>
          <div className="max-h-[52vh] min-w-0 overflow-y-auto">
            <Markdown text={form.design} />
          </div>
        </div>
      )}

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line bg-panel/95 px-1 py-3 backdrop-blur [&>button]:shrink-0 [&>button]:whitespace-nowrap">
        <Button variant="primary" size="md" disabled={saving || !dirty || !!problem} onClick={onSave} data-system-save title={problem ?? undefined}>
          <Save /> {form.isNew ? "Create design system" : "Save changes"}
        </Button>
        {dirty && (
          <Button size="md" variant="ghost" onClick={onRevert}>
            <Undo2 /> {form.isNew ? "Discard" : "Revert"}
          </Button>
        )}
        {problem && dirty && <span className="text-[11.5px] text-amber">{problem}</span>}
        <span className="flex-1" />
        {!form.isNew && (
          <>
            {canReset && (
              <Button size="md" variant="ghost" disabled={!modified} onClick={onReset} data-system-reset title={modified ? "Put this system back to what shipped with trb" : "Already the shipped version"}>
                <RotateCcw /> Reset to default
              </Button>
            )}
            <Button size="md" variant="ghost" onClick={onDuplicate}>
              <Copy /> Duplicate
            </Button>
            <Button size="md" variant="dangerGhost" onClick={onDelete}>
              <Trash2 /> Delete
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Settings → Design systems: what New app and the Design tab offer, every one editable. */
export function SystemsPage() {
  const qc = useQueryClient();
  const list = useSystems();
  const systems = list.data?.systems ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<SystemForm | null>(null);
  const [saving, setSaving] = useState(false);

  const current = systems.find((r) => r.id === sel) ?? null;
  const original = useMemo(() => (current ? toForm(current) : null), [current]);

  useEffect(() => {
    if (!sel && systems.length) setSel(systems[0]!.id);
  }, [sel, systems]);
  const base = useRef<SystemForm | null>(null);
  useEffect(() => {
    if (!original) return;
    // Take the saved copy unless the form holds edits (or is a new, unsaved system).
    setForm((f) => (!f ? original : f.isNew || f.id !== original.id ? f : base.current && sameForm(f, base.current) ? original : f));
    base.current = original;
  }, [original]);

  const after = (r: SystemList) => qc.setQueryData(SYSTEMS_KEY, { systems: r.systems, missingDefaults: r.missingDefaults });
  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast.success(ok);
      return r;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  };

  const ids = systems.map((r) => r.id);
  const select = async (id: string) => {
    if (form && original && !form.isNew && !sameForm(form, original) && !(await confirm({ title: "Discard unsaved changes?", description: `Your edits to "${form.name}" have not been saved.`, confirmLabel: "Discard", danger: true }))) return;
    if (form?.isNew && !(await confirm({ title: "Discard the new design system?", confirmLabel: "Discard", danger: true }))) return;
    setSel(id);
    setForm(toForm(systems.find((r) => r.id === id)!));
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    const payload = toSystem(form);
    const r = await run(() => (form.isNew ? post<SystemList>("/api/design/systems", payload) : put<SystemList>(`/api/design/systems/${encodeURIComponent(form.id)}`, payload)), form.isNew ? "Design system created" : "Design system saved");
    setSaving(false);
    if (r) {
      after(r);
      setSel(form.id);
      setForm(toForm(r.systems.find((x) => x.id === form.id)!));
    }
  };

  return (
    <PageShell wide title="Design systems" description="The design systems New app and the Design tab offer. Each is a DESIGN.md (the contract agents read before UI work) and a tokens.css (the values, under one shared set of names so systems are swappable). All of them are yours to edit, including the ones that came with trb; generate new ones from a project's Design tab and save them here.">
      {list.isLoading && <Skeleton className="h-64" />}
      {list.data && (
        <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1" role="list" aria-label="Design systems">
              {systems.map((s, i) => (
                <div key={s.id} role="listitem" data-system-item={s.id} className={cn("group flex flex-col gap-1.5 rounded-lg border px-2 py-1.5 transition-colors", sel === s.id && !form?.isNew ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong")}>
                  <div className="flex items-center gap-1">
                    <button onClick={() => void select(s.id)} className="min-w-0 flex-1 text-left outline-none" aria-current={sel === s.id ? "true" : undefined}>
                      <span className="block truncate text-[13px] font-medium">{s.name}</span>
                      <span className="flex items-center gap-1 text-[10.5px] text-fg-faint">
                        <span className="font-mono">{s.id}</span>
                        {s.isDefault && <span>· {s.modified ? "edited default" : "default"}</span>}
                      </span>
                    </button>
                    <span className="flex shrink-0 flex-col opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <IconButton label={`Move ${s.name} up`} size="icon-xs" disabled={i === 0} onClick={() => void run(() => post<SystemList>("/api/design/systems/reorder", { ids: moveId(ids, s.id, -1) })).then((x) => x && after(x))}>
                        <ArrowUp />
                      </IconButton>
                      <IconButton label={`Move ${s.name} down`} size="icon-xs" disabled={i === systems.length - 1} onClick={() => void run(() => post<SystemList>("/api/design/systems/reorder", { ids: moveId(ids, s.id, 1) })).then((x) => x && after(x))}>
                        <ArrowDown />
                      </IconButton>
                    </span>
                  </div>
                  <ColorStrip summary={s.summary} className="h-4" />
                </div>
              ))}
              {form?.isNew && (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-accent/60 bg-accent-soft px-2 py-1.5 text-[13px]">
                  <Plus className="size-4 text-accent" /> <span className="truncate">{form.name || "New system"}</span> <Badge tone="accent">new</Badge>
                </div>
              )}
            </div>
            <Button
              size="md"
              data-system-add
              onClick={() => {
                setSel(null);
                setForm(blankForm(ids));
              }}
            >
              <Plus /> New design system
            </Button>
            {list.data.missingDefaults.length > 0 && (
              <Button size="md" variant="ghost" data-system-restore title={`Adds back: ${list.data.missingDefaults.map((d) => d.name).join(", ")}`} onClick={() => void run(() => post<SystemList>("/api/design/systems/restore-defaults"), "Defaults restored").then((x) => x && after(x))}>
                <RotateCcw /> Restore missing defaults ({list.data.missingDefaults.length})
              </Button>
            )}
            <p className="text-[11px] leading-relaxed text-fg-faint">Stored in your trb home (design-systems.json), never in a project. A project gets its own copy as DESIGN.md and design/tokens.css when you apply one.</p>
          </div>

          <div className="min-w-0">
            {form ? (
              <Editor
                key={form.isNew ? "new" : form.id}
                form={form}
                setForm={setForm}
                original={form.isNew ? null : original}
                saved={form.isNew ? null : current}
                saving={saving}
                onSave={() => void save()}
                onRevert={() => {
                  if (form.isNew) {
                    setForm(null);
                    setSel(systems[0]?.id ?? null);
                  } else if (original) setForm(original);
                }}
                onDuplicate={() => {
                  setSel(null);
                  setForm(duplicateForm(form, ids));
                }}
                canReset={!!current?.isDefault}
                modified={!!current?.modified}
                onReset={async () => {
                  if (!(await confirm({ title: `Reset "${current?.name}" to the default?`, description: "Your changes to this design system are replaced by the version that shipped with trb.", confirmLabel: "Reset", danger: true }))) return;
                  const r = await run(() => post<SystemList>(`/api/design/systems/${encodeURIComponent(form.id)}/reset`), "Reset to default");
                  if (r) {
                    after(r);
                    setForm(toForm(r.systems.find((x) => x.id === form.id)!));
                  }
                }}
                onDelete={async () => {
                  if (!(await confirm({ title: `Delete "${form.name}"?`, description: current?.isDefault ? "It can be brought back with Restore missing defaults. Projects that use it keep their own copy." : "This cannot be undone. Projects that use it keep their own copy.", confirmLabel: "Delete", danger: true }))) return;
                  const r = await run(() => del<SystemList>(`/api/design/systems/${encodeURIComponent(form.id)}`), "Design system deleted");
                  if (r) {
                    after(r);
                    setSel(r.systems[0]?.id ?? null);
                    setForm(r.systems[0] ? toForm(r.systems[0]) : null);
                  }
                }}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-line p-8 text-center text-[13px] text-fg-muted">No design systems. Add one, or restore the defaults.</div>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
