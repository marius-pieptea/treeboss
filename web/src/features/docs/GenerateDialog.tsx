/**
 * Write or refresh documentation with an agent: which pages, which engine and model (or agent), whether to
 * review a plan first. The dialog asks the daemon what would run before anything starts, so "Refresh stale
 * pages" says which pages and what changed under each.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Badge, SegTabs, Spinner } from "@/components/ui/misc";
import { EngineIcon } from "@/components/ui/engine-icon";
import { ModelSelect } from "@/components/ui/model-select";
import { useAgents, useEngines, useSession } from "@/lib/queries";
import { useWs } from "@/lib/store";
import { cn } from "@/lib/utils";
import { previewGenerate, useGenerate, type GenerateArgs } from "./data";
import { emptyGen, FRESHNESS_LABEL, freshnessTone, KIND_HINT, KIND_LABEL, needsInput, type Freshness, type GenChoice, type GenKind } from "./logic";

export interface GenSpec {
  kind: GenKind;
  /** One existing page to refresh, or the page a new one should be written at. */
  page?: string;
  pages?: string[];
  stale?: boolean;
  /** The kind is fixed (a refresh from a page's header): hide the kind picker. */
  locked?: boolean;
  input?: string;
}

const PICKABLE: GenKind[] = ["overview", "architecture", "module", "conventions", "runbook", "adr"];

function titleOf(spec: GenSpec): string {
  if (spec.stale) return "Refresh the stale pages";
  if (spec.pages?.length) return `Refresh ${spec.pages.length} pages`;
  if (spec.page && spec.kind !== "adr") return `Refresh ${spec.page.replace(/^.*\//, "")}`;
  return "Write documentation";
}

export function GenerateDialog({ open, onOpenChange, root, spec }: { open: boolean; onOpenChange: (o: boolean) => void; root: string; spec: GenSpec | null }) {
  const ws = useWs();
  const active = useSession(ws.activeSession);
  const engines = useEngines();
  const agents = useAgents();
  const generate = useGenerate(root);
  const [kind, setKind] = useState<GenKind>("overview");
  const [c, setC] = useState<GenChoice>(emptyGen());
  const current = active.data?.session && active.data.session.status !== "closed" ? active.data.session : null;

  useEffect(() => {
    if (open && spec) {
      setKind(spec.kind);
      setC({ ...emptyGen(), input: spec.input ?? "" });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const installed = useMemo(() => (engines.data ?? []).filter((e) => e.installed), [engines.data]);
  const set = (patch: Partial<GenChoice>) => setC((x) => ({ ...x, ...patch }));
  const useCurrent = c.where === "current" && !!current && kind === "adr";

  const args: GenerateArgs = {
    kind,
    ...(spec?.page && kind !== "refresh" ? { page: spec.page } : {}),
    ...(kind === "refresh" && spec?.pages?.length ? { pages: spec.pages } : {}),
    ...(kind === "refresh" && spec?.page && !spec.pages?.length && !spec.stale ? { pages: [spec.page] } : {}),
    ...(spec?.stale ? { stale: true } : {}),
    ...(c.input.trim() ? { input: c.input.trim() } : {}),
    ...(!useCurrent && c.engine ? { engine: c.engine } : {}),
    ...(!useCurrent && c.model ? { model: c.model } : {}),
    ...(!useCurrent && c.agent ? { agent: c.agent } : {}),
    ...(useCurrent ? { sessionId: current!.id } : {}),
    ...(c.planFirst ? { planFirst: true } : {}),
  };
  const ready = !!spec && (!needsInput(kind) || !!c.input.trim() || (kind === "module" && !!spec.page) || useCurrent);
  const preview = useQuery({
    queryKey: ["docs", root, "preview", JSON.stringify(args)],
    enabled: open && !!spec && ready,
    queryFn: () => previewGenerate(root, args),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  if (!spec) return null;
  const run = () => {
    if (!ready || generate.isPending) return;
    generate.mutate(args, {
      onSuccess: (r) => {
        onOpenChange(false);
        toast.success(`${r.targets.length ? `${r.targets.some((t) => t.exists) ? "Refreshing" : "Writing"} ${r.targets.map((t) => t.path.replace(/^.*\//, "")).join(", ")}` : "Writing the decision record"}. Review the diff in Source Control when it finishes.`);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={540}
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent" /> {titleOf(spec)}
        </span>
      }
      description="An agent reads the code and writes the pages into the docs folder. Nothing is committed: you review the diff first."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" data-gen-confirm disabled={!ready || generate.isPending || (!!preview.error && !preview.data)} onClick={run}>
            {generate.isPending ? <Spinner className="text-accent-fg" /> : <Sparkles />} {c.planFirst ? "Start with a plan" : spec.stale || kind === "refresh" ? "Refresh" : "Generate"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && run()}>
        {!spec.locked && (
          <Field label="What to write" hint={KIND_HINT[kind]}>
            <Select aria-label="Kind of page" value={kind} onChange={(v) => setKind(v as GenKind)} options={PICKABLE.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
          </Field>
        )}

        {needsInput(kind) && (
          <Field label={kind === "module" ? "Which module or area" : "What was decided"} hint={kind === "module" ? "A name or a path, like “the session manager” or src/sessions." : kind === "adr" && current ? "Or leave a short note and take it from the open conversation below." : undefined}>
            {kind === "adr" ? <Textarea data-gen-input rows={2} value={c.input} onChange={(e) => set({ input: e.target.value })} placeholder="Use SQLite for session state instead of files" /> : <Input data-gen-input value={c.input} onChange={(e) => set({ input: e.target.value })} placeholder="The session manager" />}
          </Field>
        )}

        {kind === "adr" && current && (
          <SegTabs
            value={c.where}
            onChange={(where) => set({ where })}
            items={[
              { value: "new", label: "New session" },
              { value: "current", label: `From this conversation: ${current.title.slice(0, 22)}` },
            ]}
          />
        )}

        {!useCurrent && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Engine" hint="Empty uses the docs_engine setting.">
              <Select
                aria-label="Engine"
                value={c.engine}
                onChange={(engine) => set({ engine, model: "" })}
                placeholder="Default"
                options={[{ value: "", label: "Default" }, ...installed.map((e) => ({ value: e.id, label: (<span className="flex items-center gap-1.5"><EngineIcon engine={e.id} className="size-3.5" />{e.label}</span>) }))]}
              />
            </Field>
            <Field label="Model">
              <ModelSelect engine={c.engine} value={c.model} onChange={(model) => set({ model })} disabled={!c.engine} disabledReason="Pick an engine first" />
            </Field>
            <Field label="Agent" hint="Its instructions and skills apply.">
              <Select aria-label="Agent" value={c.agent} onChange={(agent) => set({ agent })} placeholder="None" options={[{ value: "", label: "None" }, ...(agents.data ?? []).map((a) => ({ value: a.name, label: a.title || a.name }))]} />
            </Field>
            <div className="flex items-end">
              <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-raised px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium">Review a plan first</div>
                  <p className="text-[11px] leading-snug text-fg-muted">Read-only until you approve.</p>
                </div>
                <Switch checked={c.planFirst} onChange={(planFirst) => set({ planFirst })} label="Review a plan first" />
              </div>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-line bg-raised" data-gen-preview>
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-muted">
            What will run {preview.isFetching && <Spinner className="size-3" />}
            {preview.data && <span className="ml-auto font-mono normal-case tracking-normal text-fg-faint">by {preview.data.by}</span>}
          </div>
          {!ready ? (
            <p className="px-3 py-2 text-xs text-fg-muted">Say {kind === "module" ? "which module" : "what was decided"} to see what would run.</p>
          ) : preview.error ? (
            <p className="px-3 py-2 text-xs text-amber" data-gen-error>
              {(preview.error as Error).message}
            </p>
          ) : preview.data ? (
            <ul className="max-h-[170px] overflow-y-auto p-1">
              {preview.data.targets.length === 0 && <li className="px-2 py-1.5 text-xs text-fg-muted">A new decision record in the decisions folder.</li>}
              {preview.data.targets.map((t) => (
                <li key={t.path} className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-hover">
                  <div className="flex items-center gap-2">
                    <FileText className="size-3.5 shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{t.path}</span>
                    <Badge tone={t.exists ? "neutral" : "accent"}>{t.exists ? "refresh" : "new"}</Badge>
                    {t.state && t.state !== "unmanaged" && <Badge tone={freshnessTone(t.state as Freshness)}>{FRESHNESS_LABEL[t.state as Freshness]}</Badge>}
                  </div>
                  {t.changed && t.changed.length > 0 && (
                    <div className="truncate pl-5 font-mono text-[10.5px] text-fg-faint" title={t.changed.join("\n")}>
                      changed: {t.changed.slice(0, 4).join(", ")}
                      {(t.changedTotal ?? t.changed.length) > 4 ? `, +${(t.changedTotal ?? t.changed.length) - 4} more` : ""}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex justify-center py-3">
              <Spinner />
            </div>
          )}
        </div>
        <p className={cn("text-[11px] leading-snug text-fg-faint")}>Human-written sections between <span className="font-mono">&lt;!-- keep --&gt;</span> markers are left alone. The agent only writes inside the docs folder; anything else it changes is flagged afterwards.</p>
      </div>
    </Dialog>
  );
}

/** The dialog plus the function that opens it, for any place that offers "write" or "refresh". */
export function useGenerateDialog(root: string) {
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<GenSpec | null>(null);
  return {
    start: (s: GenSpec) => {
      setSpec(s);
      setOpen(true);
    },
    dialog: <GenerateDialog open={open} onOpenChange={setOpen} root={root} spec={spec} />,
  };
}
