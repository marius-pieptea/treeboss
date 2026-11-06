import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Copy, GitFork, Plus, RotateCcw, Save, Trash2, Undo2, X } from "lucide-react";
import { del, get, post, put } from "@/lib/api";
import { Button, IconButton } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { PageShell } from "../settings/shared";
import { RecipeIcon } from "./icons";
import { TemplateDefaults } from "./DefaultsPickers";
import { argvOf, blankForm, duplicateForm, filePaths, formProblem, hasStarter, ICONS, looksLikeGithub, moveId, removeFile, sameForm, setFileContent, toForm, toRecipe, type RecipeForm, type RecipeList, type RepoRow } from "./logic";

export const TEMPLATES_KEY = ["scaffold", "recipes"] as const;

export const useTemplates = (enabled = true) => useQuery({ queryKey: TEMPLATES_KEY, queryFn: () => get<RecipeList>("/api/scaffold/recipes"), enabled });

/** The argument list a command line stands for, one box per argument: exactly what will run. */
function Argv({ line }: { line: string }) {
  const argv = argvOf(line);
  if (!argv.length) return <div className="text-[11px] text-fg-faint">Nothing will run.</div>;
  return (
    <div className="flex flex-wrap gap-1" aria-label="Arguments as they will be passed">
      {argv.map((a, i) => (
        <span key={i} className={cn("max-w-full truncate rounded border px-1.5 font-mono text-[11px]", i === 0 ? "border-accent/40 bg-accent-soft text-fg" : "border-line bg-raised text-fg-muted")} title={a}>
          {a}
        </span>
      ))}
    </div>
  );
}

function TemplateFiles({ form, setForm }: { form: RecipeForm; setForm: (f: RecipeForm) => void }) {
  const paths = filePaths(form);
  const [open, setOpen] = useState<string | null>(null);
  const shown = open && paths.includes(open) ? open : (paths[0] ?? null);
  if (!paths.length) return null;
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3" data-template-files>
      <span className="text-label font-medium uppercase tracking-label text-fg-muted">Template files ({paths.length})</span>
      <div className="flex flex-col gap-1" role="list" aria-label="Template files">
        {paths.map((p) => (
          <div key={p} role="listitem" className={cn("flex items-center gap-1 rounded border px-1.5", shown === p ? "border-accent/60 bg-accent-soft" : "border-line")}>
            <button type="button" onClick={() => setOpen(p)} aria-current={shown === p ? "true" : undefined} className="min-w-0 flex-1 truncate py-1 text-left font-mono text-label outline-none" title={p}>
              {p}
            </button>
            <IconButton label={`Remove ${p}`} size="icon-xs" onClick={() => setForm(removeFile(form, p))}>
              <X />
            </IconButton>
          </div>
        ))}
      </div>
      {shown && <Textarea value={form.files![shown]} onChange={(e) => setForm(setFileContent(form, shown, e.target.value))} className="h-48 font-mono text-xs" spellCheck={false} aria-label={`Content of ${shown}`} />}
      <p className="text-label text-fg-muted">Written into the project after the generator, never over a file that is already there. <span className="font-mono">{"{{name}}"}</span> becomes the folder's name as a slug and <span className="font-mono">{"{{title}}"}</span> the name as words.</p>
    </section>
  );
}

function Editor({ form, setForm, original, onSave, onRevert, onDelete, onDuplicate, onReset, saving, canReset, modified }: { form: RecipeForm; setForm: (f: RecipeForm) => void; original: RecipeForm | null; onSave: () => void; onRevert: () => void; onDelete: () => void; onDuplicate: () => void; onReset: () => void; saving: boolean; canReset: boolean; modified: boolean }) {
  const set = <K extends keyof RecipeForm>(k: K, v: RecipeForm[K]) => setForm({ ...form, [k]: v });
  const dirty = !original || !sameForm(form, original);
  const problem = formProblem(form);
  const starter = hasStarter(form);
  const setRepos = (repos: RepoRow[]) => setForm({ ...form, repos, ...(repos.some((r) => r.url.trim() && r.role === "starter") ? { generate: "" } : {}) });
  const setRepo = (i: number, patch: Partial<RepoRow>) => setRepos(form.repos.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex min-w-0 flex-col gap-4" data-template-editor>
      <Field label="Name">
        <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={60} data-template-name aria-label="Template name" />
      </Field>
      <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-3">
        <Field label="Tag" hint="web, api, mobile…">
          <Input value={form.tag} onChange={(e) => set("tag", e.target.value)} maxLength={20} aria-label="Template tag" />
        </Field>
        <Field label="Icon">
          <div className="flex flex-wrap gap-0.5" role="radiogroup" aria-label="Icon">
            {ICONS.map((i) => (
              <button key={i} type="button" role="radio" aria-checked={form.icon === i} aria-label={i} title={i} onClick={() => set("icon", i)} className={cn("flex size-7 items-center justify-center rounded border outline-none transition-colors", form.icon === i ? "border-accent/60 bg-accent-soft text-accent" : "border-transparent text-fg-faint hover:bg-hover")}>
                <RecipeIcon name={i} className="size-3.5" />
              </button>
            ))}
          </div>
        </Field>
      </div>
      <Field label="Description">
        <Input value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={300} aria-label="Template description" />
      </Field>

      <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <Field label="Generator command" hint={<>Runs <b>exactly as written</b>, with no shell: <span className="font-mono">&amp;&amp;</span>, pipes, <span className="font-mono">$VAR</span> and quotes-as-shell do not work (quotes only group words here). It runs inside the new folder, so pass <span className="font-mono">.</span> as the target.</>}>
          <Input value={form.generate} onChange={(e) => set("generate", e.target.value)} className="font-mono text-xs" spellCheck={false} data-template-generate aria-label="Generator command" disabled={starter} placeholder={starter ? "Not used: the starter repo is the base" : undefined} />
        </Field>
        <Argv line={form.generate} />
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-line p-3" data-template-repos>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">GitHub repos</span>
          <Button size="sm" variant="ghost" onClick={() => setRepos([...form.repos, { url: "", ref: "", role: form.repos.some((r) => r.role === "starter") ? "reference" : "starter", note: "" }])} data-template-add-repo>
            <Plus /> Add repo
          </Button>
        </div>
        {form.repos.length === 0 && <div className="text-[11px] text-fg-faint">None. Attach a <b>starter</b> to copy as the project base, or a <b>reference</b> the agent reads first.</div>}
        {form.repos.map((r, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-md border border-line bg-raised/40 p-2" data-template-repo={i}>
            <div className="flex items-center gap-1.5">
              <GitFork className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
              <Input value={r.url} onChange={(e) => setRepo(i, { url: e.target.value })} className="font-mono text-xs" spellCheck={false} placeholder="owner/repo or https://github.com/owner/repo" aria-label={`Repo ${i + 1} URL`} aria-invalid={!!r.url.trim() && !looksLikeGithub(r.url)} />
              <IconButton label="Remove repo" onClick={() => setRepos(form.repos.filter((_, j) => j !== i))}>
                <X />
              </IconButton>
            </div>
            <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-1.5">
              <Select
                size="sm"
                value={r.role}
                onChange={(v) => setRepo(i, { role: v as RepoRow["role"] })}
                options={[
                  { value: "starter", label: "Starter (base)" },
                  { value: "reference", label: "Reference (read)" },
                ]}
                aria-label={`Repo ${i + 1} role`}
              />
              <Input value={r.ref} onChange={(e) => setRepo(i, { ref: e.target.value })} className="font-mono text-xs" spellCheck={false} placeholder="branch or tag" aria-label={`Repo ${i + 1} ref`} />
            </div>
            <Input value={r.note} onChange={(e) => setRepo(i, { note: e.target.value })} placeholder="Hint for the agent: what to take from it" maxLength={300} aria-label={`Repo ${i + 1} hint`} />
          </div>
        ))}
        <p className="text-[11px] text-fg-faint">
          Only github.com repos. A <b>starter</b> is shallow-cloned into the new folder with its history dropped, and replaces the generator. A <b>reference</b> is cloned into <span className="font-mono">.reference/</span> (git-ignored); the agent is told to read it before changing anything. Nothing in a repo is run. Private repos work only if git on this computer is signed in to GitHub.
        </p>
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">After generating</span>
          <Button size="xs" variant="ghost" onClick={() => set("steps", [...form.steps, ""])}>
            <Plus /> Add step
          </Button>
        </div>
        {form.steps.length === 0 && <div className="text-[11px] text-fg-faint">No steps: the generator installs by itself (or there is nothing to install).</div>}
        {form.steps.map((s, i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="w-4 shrink-0 text-right font-mono text-[10.5px] text-fg-faint">{i + 1}</span>
              <Input value={s} onChange={(e) => set("steps", form.steps.map((x, j) => (j === i ? e.target.value : x)))} className="font-mono text-xs" spellCheck={false} aria-label={`Step ${i + 1}`} placeholder="bun install" />
              <IconButton label={`Remove step ${i + 1}`} size="icon-sm" onClick={() => set("steps", form.steps.filter((_, j) => j !== i))}>
                <X />
              </IconButton>
            </div>
            <div className="pl-5.5">
              <Argv line={s} />
            </div>
          </div>
        ))}
        <p className="text-[11px] text-fg-faint">Each step is its own command, run in order in the project folder, also without a shell. A failing step is logged and the rest continue.</p>
      </section>

      <TemplateFiles form={form} setForm={setForm} />

      <Field label="Rules for AGENTS.md" hint="One rule per line. They are added to the project's AGENTS.md (and CLAUDE.md) so every agent follows them.">
        <Textarea value={form.rules} onChange={(e) => set("rules", e.target.value)} className="h-28 text-xs" aria-label="Rules" />
      </Field>
      <Field label="Intro line for AGENTS.md" hint="One or two sentences describing the project, written once at the top when the generator did not create AGENTS.md.">
        <Input value={form.intro} onChange={(e) => set("intro", e.target.value)} maxLength={500} aria-label="Intro" />
      </Field>
      <Field label="Starter prompt" hint="The first message of the session that opens after scaffolding. What the user types in 'What should it be?' is appended.">
        <Textarea value={form.starterPrompt} onChange={(e) => set("starterPrompt", e.target.value)} className="h-24 text-xs" aria-label="Starter prompt" />
      </Field>
      <TemplateDefaults practices={form.practices} checklists={form.checklists} onPractices={(ids) => set("practices", ids)} onChecklists={(ids) => set("checklists", ids)} />

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line bg-panel/95 px-1 py-3 backdrop-blur [&>button]:shrink-0 [&>button]:whitespace-nowrap">
        <Button variant="primary" size="md" disabled={saving || !dirty || !!problem} onClick={onSave} data-template-save title={problem ?? undefined}>
          <Save /> {form.isNew ? "Create template" : "Save changes"}
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
              <Button size="md" variant="ghost" disabled={!modified} onClick={onReset} data-template-reset title={modified ? "Put this template back to what shipped with trb" : "Already the shipped version"}>
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

/** Settings → Templates: the recipes the New app dialog offers, every one of them editable. */
export function TemplatesPage() {
  const qc = useQueryClient();
  const list = useTemplates();
  const recipes = list.data?.recipes ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<RecipeForm | null>(null);
  const [saving, setSaving] = useState(false);

  const current = recipes.find((r) => r.id === sel) ?? null;
  const original = useMemo(() => (current ? toForm(current) : null), [current]);

  // Select the first template once the list is there, and follow the saved copy when it changes.
  useEffect(() => {
    if (!sel && recipes.length) setSel(recipes[0]!.id);
  }, [sel, recipes]);
  const base = useRef<RecipeForm | null>(null);
  useEffect(() => {
    if (!original) return;
    // Take the saved copy unless the form holds edits (or is a new, unsaved template).
    setForm((f) => (!f ? original : f.isNew || f.id !== original.id ? f : base.current && sameForm(f, base.current) ? original : f));
    base.current = original;
  }, [original]);

  const after = (r: RecipeList) => qc.setQueryData(TEMPLATES_KEY, r);
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

  const ids = recipes.map((r) => r.id);
  const select = async (id: string) => {
    if (form && original && !sameForm(form, original) && !form.isNew && !(await confirm({ title: "Discard unsaved changes?", description: `Your edits to "${form.name}" have not been saved.`, confirmLabel: "Discard", danger: true }))) return;
    if (form?.isNew && !(await confirm({ title: "Discard the new template?", confirmLabel: "Discard", danger: true }))) return;
    setSel(id);
    setForm(toForm(recipes.find((r) => r.id === id)!));
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    const payload = toRecipe(form);
    const r = await run(() => (form.isNew ? post<RecipeList & { recipe: { id: string } }>("/api/scaffold/recipes", payload) : put<RecipeList>(`/api/scaffold/recipes/${encodeURIComponent(form.id)}`, payload)), form.isNew ? "Template created" : "Template saved");
    setSaving(false);
    if (r) {
      after(r);
      setSel(form.id);
      setForm(toForm(r.recipes.find((x) => x.id === form.id)!));
    }
  };

  return (
    <PageShell wide title="Templates" description="The recipes behind New app on the home screen. Each one runs its generator in an empty folder, then its steps, seeds AGENTS.md with your rules and opens a session with the starter prompt. All of them are yours to edit, including the ones that came with trb.">
      {list.isLoading && <Skeleton className="h-64" />}
      {list.data && (
        <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1" role="list" aria-label="Templates">
              {recipes.map((r, i) => (
                <div key={r.id} role="listitem" data-template-item={r.id} className={cn("group flex items-center gap-1 rounded-lg border px-2 py-1.5 transition-colors", sel === r.id && !form?.isNew ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong")}>
                  <button onClick={() => void select(r.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none" aria-current={sel === r.id ? "true" : undefined}>
                    <RecipeIcon name={r.icon} className="size-4 shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{r.name}</span>
                      <span className="flex items-center gap-1 text-[10.5px] text-fg-faint">
                        {r.tag && <span>{r.tag}</span>}
                        {r.isDefault && <span>{r.modified ? "edited default" : "default"}</span>}
                      </span>
                    </span>
                  </button>
                  <span className="flex shrink-0 flex-col opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <IconButton label={`Move ${r.name} up`} size="icon-xs" disabled={i === 0} onClick={() => void run(() => post<RecipeList>("/api/scaffold/recipes/reorder", { ids: moveId(ids, r.id, -1) })).then((x) => x && after(x))}>
                      <ArrowUp />
                    </IconButton>
                    <IconButton label={`Move ${r.name} down`} size="icon-xs" disabled={i === recipes.length - 1} onClick={() => void run(() => post<RecipeList>("/api/scaffold/recipes/reorder", { ids: moveId(ids, r.id, 1) })).then((x) => x && after(x))}>
                      <ArrowDown />
                    </IconButton>
                  </span>
                </div>
              ))}
              {form?.isNew && (
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-accent/60 bg-accent-soft px-2 py-1.5 text-[13px]">
                  <Plus className="size-4 text-accent" /> <span className="truncate">{form.name || "New template"}</span> <Badge tone="accent">new</Badge>
                </div>
              )}
            </div>
            <Button
              size="md"
              data-template-add
              onClick={() => {
                setSel(null);
                setForm(blankForm(ids));
              }}
            >
              <Plus /> New template
            </Button>
            {list.data.missingDefaults.length > 0 && (
              <Button size="md" variant="ghost" data-template-restore title={`Adds back: ${list.data.missingDefaults.map((d) => d.name).join(", ")}`} onClick={() => void run(() => post<RecipeList & { added: string[] }>("/api/scaffold/recipes/restore-defaults"), "Defaults restored").then((x) => x && after(x))}>
                <RotateCcw /> Restore missing defaults ({list.data.missingDefaults.length})
              </Button>
            )}
            <p className="text-[11px] leading-relaxed text-fg-faint">Stored in your trb home (recipes.json), never in a project. Safety checks on the target folder (empty, not your home, not a link) apply to every template.</p>
          </div>

          <div className="min-w-0">
            {form ? (
              <Editor
                form={form}
                setForm={setForm}
                original={form.isNew ? null : original}
                saving={saving}
                onSave={() => void save()}
                onRevert={() => {
                  if (form.isNew) {
                    setForm(null);
                    setSel(recipes[0]?.id ?? null);
                  } else if (original) setForm(original);
                }}
                onDuplicate={() => {
                  setSel(null);
                  setForm(duplicateForm(form, ids));
                }}
                canReset={!!current?.isDefault}
                modified={!!current?.modified}
                onReset={async () => {
                  if (!(await confirm({ title: `Reset "${current?.name}" to the default?`, description: "Your changes to this template are replaced by the version that shipped with trb.", confirmLabel: "Reset", danger: true }))) return;
                  const r = await run(() => post<RecipeList>(`/api/scaffold/recipes/${encodeURIComponent(form.id)}/reset`), "Reset to default");
                  if (r) {
                    after(r);
                    setForm(toForm(r.recipes.find((x) => x.id === form.id)!));
                  }
                }}
                onDelete={async () => {
                  if (!(await confirm({ title: `Delete "${form.name}"?`, description: current?.isDefault ? "It can be brought back with Restore missing defaults." : "This cannot be undone.", confirmLabel: "Delete", danger: true }))) return;
                  const r = await run(() => del<RecipeList>(`/api/scaffold/recipes/${encodeURIComponent(form.id)}`), "Template deleted");
                  if (r) {
                    after(r);
                    setSel(r.recipes[0]?.id ?? null);
                    setForm(r.recipes[0] ? toForm(r.recipes[0]) : null);
                  }
                }}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-line p-8 text-center text-[13px] text-fg-muted">No templates. Add one, or restore the defaults.</div>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
