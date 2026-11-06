import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, FolderCog, RotateCcw, Save } from "lucide-react";
import { get, put } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { useEditorPrefs } from "@/features/editor/prefs";
import { Button } from "@/components/ui/button";
import { Input, Switch } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/misc";
import { PageShell } from "./shared";

interface Pref {
  id: "plans" | "docs" | "roadmap";
  label: string;
  help: string;
  placeholder: string;
  def: string;
  read: (id: string) => Promise<string>;
  write: (id: string, value: string | null) => Promise<unknown>;
  /** What else shows this setting, so it can refresh. */
  invalidate: string[];
}

// Where a workspace keeps what the app writes for it. All three are plain relative paths inside the workspace; the app creates nothing until it needs to.
const PREFS: Pref[] = [
  {
    id: "plans",
    label: "Plans folder",
    help: "Where plan mode writes its plans (markdown files you can edit and commit).",
    placeholder: "plans",
    def: "plans",
    read: (id) => get<{ dir: string }>(`/api/workspaces/${id}/plans-dir`).then((r) => r.dir),
    write: (id, v) => put(`/api/workspaces/${id}/plans-dir`, { dir: v }),
    invalidate: ["attachments", "plan-state"],
  },
  {
    id: "docs",
    label: "Docs folder",
    help: "The project documentation the Docs view reads and the docs generator writes.",
    placeholder: "docs",
    def: "docs",
    read: (id) => get<{ docs: { dir: string } }>(`/api/docs/${id}?fast=1`).then((r) => r.docs.dir),
    write: (id, v) => put(`/api/docs/${id}/dir`, { dir: v }),
    invalidate: ["docs", "attachments"],
  },
  {
    id: "roadmap",
    label: "Roadmap file",
    help: "The markdown file the Roadmap view edits. Lanes are its headings, items its checkbox lines.",
    placeholder: "ROADMAP.md",
    def: "ROADMAP.md",
    read: (id) => get<{ path: string }>(`/api/roadmap/${id}/choices`).then((r) => r.path),
    write: (id, v) => put(`/api/roadmap/${id}/prefs`, { path: v ?? "ROADMAP.md" }),
    invalidate: ["roadmap"],
  },
];

function Row({ pref, workspace }: { pref: Pref; workspace: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["workspace-pref", pref.id, workspace], queryFn: () => pref.read(workspace), staleTime: 3000 });
  const current = q.data ?? pref.def;
  const [text, setText] = useState(current);
  const [saved, setSaved] = useState(false);
  useEffect(() => setText(current), [current]);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1600);
    return () => clearTimeout(t);
  }, [saved]);
  const save = useMutation({
    mutationFn: (v: string | null) => pref.write(workspace, v),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ["workspace-pref", pref.id] });
      for (const k of pref.invalidate) void qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : `Could not save the ${pref.label.toLowerCase()}`),
  });
  const dirty = text.trim() !== current;
  const custom = current !== pref.def;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0" data-pref={pref.id}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          {pref.label}
          {custom && <span className="rounded bg-accent-soft px-1.5 py-px text-[10px] font-normal text-accent">custom</span>}
        </div>
        <p className="max-w-[56ch] text-[12px] leading-snug text-fg-muted">{pref.help}</p>
      </div>
      <div className="flex items-center gap-1.5">
        {q.isLoading ? (
          <Skeleton className="h-8 w-56" />
        ) : (
          <Input
            className="h-8 w-56 font-mono text-[12.5px]"
            value={text}
            placeholder={pref.placeholder}
            aria-label={pref.label}
            data-pref-input={pref.id}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty && text.trim()) save.mutate(text.trim());
              if (e.key === "Escape") setText(current);
            }}
          />
        )}
        <Button size="sm" variant="primary" data-pref-save={pref.id} disabled={!dirty || !text.trim() || save.isPending} onClick={() => save.mutate(text.trim())}>
          {saved ? <Check /> : null} {saved ? "Saved" : "Save"}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={`Reset ${pref.label} to ${pref.def}`} title={`Back to ${pref.def}`} data-pref-reset={pref.id} disabled={!custom || save.isPending} onClick={() => save.mutate(null)}>
          <RotateCcw />
        </Button>
      </div>
    </div>
  );
}

export function WorkspacePage() {
  const { root, workspace } = useWorkspace();
  const autosave = useEditorPrefs((s) => s.autosave);
  const setAutosave = useEditorPrefs((s) => s.setAutosave);
  return (
    <PageShell title="Workspace" description={`Where ${workspace.name ?? "this workspace"} keeps plans, docs and the roadmap. Paths are relative to the project folder; changing one moves nothing, it only changes where the app looks and writes next.`}>
      <section className="animate-slide-up">
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          <FolderCog className="size-3.5" /> Folders
        </h2>
        <div className="overflow-hidden rounded-xl border border-line">
          {PREFS.map((p) => (
            <Row key={p.id} pref={p} workspace={root} />
          ))}
        </div>
      </section>
      <section className="animate-slide-up">
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          <Save className="size-3.5" /> Editing
        </h2>
        <div className="overflow-hidden rounded-xl border border-line">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3" data-pref="autosave">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">Autosave</div>
              <p className="max-w-[56ch] text-[12px] leading-snug text-fg-muted">Save a file about a second after you stop typing in it. Off, a file is saved only with Cmd+S or Ctrl+S, or Save All.</p>
            </div>
            <Switch checked={autosave} onChange={setAutosave} label="Autosave" />
          </div>
        </div>
      </section>
    </PageShell>
  );
}
