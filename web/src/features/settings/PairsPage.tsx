import { useMemo, useState } from "react";
import { ArrowRight, Copy, Crown, Layers, Pencil, Plus, Sparkles, Trash2, UserRoundCog, Users } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/overlay";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { confirm } from "@/components/ui/dialogs";
import { useGlow } from "@/lib/hooks";
import { useAgents, useEngines, usePairs, qk } from "@/lib/queries";
import type { EngineInfo, Pair, PairRecipe } from "@/lib/types";
import { api, useAction, useRecipes, useRoles } from "./data";
import { emptyPairForm, pairToForm, type PairForm } from "./logic";
import { PairEditor } from "./PairEditor";
import { EngineChip, PageShell } from "./shared";
import { DIALOG_PAGE, useSettingsUi } from "./ui-state";
import { useEffect } from "react";

function missing(engines: EngineInfo[] | undefined, id: string | null | undefined): boolean {
  if (!id || !engines) return false;
  const e = engines.find((x) => x.id === id);
  return !e || !e.installed;
}

function PairCard({ pair, engines, onEdit, onDuplicate, onDelete, delay }: { pair: Pair; engines: EngineInfo[] | undefined; onEdit: () => void; onDuplicate: () => void; onDelete: () => void; delay: number }) {
  const glow = useGlow();
  const roles = Object.entries(pair.roles ?? {});
  const agents = useAgents().data;
  const anyMissing = missing(engines, pair.lead_engine) || (pair.mode === "heads" ? missing(engines, pair.heads_engine) : roles.some(([, r]) => missing(engines, r.engine)));
  return (
    <div {...glow} style={{ animationDelay: `${delay}ms` }} className="glow-surface group animate-slide-up rounded-xl border border-line bg-bg/40 p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[14px] font-semibold">{pair.title}</h3>
            <Badge tone={pair.mode === "roles" ? "violet" : "accent"}>{pair.mode === "roles" ? "by role" : "same heads"}</Badge>
            {pair.max_heads != null && <Badge>≤ {pair.max_heads} heads</Badge>}
            {anyMissing && <Badge tone="amber" title="One of this pair's engines is not installed">engine missing</Badge>}
          </div>
        </div>
        <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconButton label="Edit" size="icon-sm" onClick={onEdit}>
            <Pencil />
          </IconButton>
          <IconButton label="Duplicate" size="icon-sm" onClick={onDuplicate}>
            <Copy />
          </IconButton>
          <IconButton label="Delete" size="icon-sm" variant="dangerGhost" onClick={onDelete}>
            <Trash2 />
          </IconButton>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[44px_1fr] items-center gap-x-2 gap-y-1.5">
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          <Crown className="size-3" /> Lead
        </span>
        <div>
          <EngineChip id={pair.lead_engine} model={pair.lead_model} effort={pair.lead_effort} missing={missing(engines, pair.lead_engine)} />
        </div>
        <span className="flex items-center gap-1 self-start pt-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          <Users className="size-3" /> Heads
        </span>
        {pair.mode === "heads" ? (
          <div className="min-w-0">
            <EngineChip id={pair.heads_engine} model={pair.heads_model} effort={pair.heads_effort} missing={missing(engines, pair.heads_engine)} />
          </div>
        ) : (
          <div className="grid min-w-0 gap-1">
            {roles.map(([key, r]) => (
              <div key={key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <ArrowRight className="size-3 shrink-0 text-fg-faint" />
                <span className="w-[68px] shrink-0 truncate font-mono text-[11px] text-fg-muted" title={r.instructions ?? undefined}>
                  {key}
                </span>
                {(() => {
                  // A role with no engine of its own runs on its agent's preference: show that, dimmed, instead of "inherits".
                  const a = r.agent ? agents?.find((x) => x.name === r.agent) : undefined;
                  const fromAgent = !r.engine && !!a?.engine;
                  if (!fromAgent) return <EngineChip id={r.engine} model={r.model} effort={r.effort} missing={missing(engines, r.engine)} className="min-w-0" />;
                  return (
                    <span title={`From the agent “${a!.title || a!.name}”`} className="min-w-0 opacity-70">
                      <EngineChip id={a!.engine} model={r.model || a!.model} effort={r.effort || a!.effort} missing={missing(engines, a!.engine)} className="min-w-0" />
                    </span>
                  );
                })()}
                {r.agent && (
                  <Badge tone="blue" className="min-w-0 max-w-full" title={`Runs as the agent “${r.agent}”`}>
                    <UserRoundCog className="size-2.5 shrink-0" />
                    <span className="min-w-0 truncate">{r.agent}</span>
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecipeCard({ recipe, onUse, delay }: { recipe: PairRecipe; onUse: () => void; delay: number }) {
  const glow = useGlow();
  return (
    <button {...glow} onClick={onUse} style={{ animationDelay: `${delay}ms` }} className="glow-surface animate-slide-up flex flex-col gap-1.5 rounded-xl border border-line bg-bg/40 p-3.5 text-left outline-none transition-[border-color,transform] hover:border-line-strong focus-visible:border-accent/60 active:scale-[0.99]">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <Sparkles className="size-3.5 text-accent" />
        {recipe.title}
      </div>
      <div className="text-xs text-fg-muted">{recipe.tagline}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <EngineChip id={recipe.lead_engine} model={recipe.lead_model} />
        <ArrowRight className="size-3 text-fg-faint" />
        {recipe.mode === "heads" ? <EngineChip id={recipe.heads_engine} model={recipe.heads_model} /> : Object.entries(recipe.roles ?? {}).map(([k, r]) => <EngineChip key={k} id={r.engine} />)}
      </div>
    </button>
  );
}

export function PairsPage() {
  const pairs = usePairs();
  const engines = useEngines();
  const recipes = useRecipes();
  const roles = useRoles();
  const agents = useAgents();
  const dialog = useSettingsUi((s) => s.dialog);
  const closeDialog = useSettingsUi((s) => s.close);
  const pendingPair = useSettingsUi((s) => s.pendingPair);

  const [editor, setEditor] = useState<{ form: PairForm; id: string | null } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // "New pair…" from the command palette lands here.
  useEffect(() => {
    if (dialog && DIALOG_PAGE[dialog] === "pairs") {
      setEditor({ form: emptyPairForm(), id: null });
      closeDialog();
    }
  }, [dialog, closeDialog]);

  // An agent card links here: open that pair in the editor.
  useEffect(() => {
    if (!pendingPair || !pairs.data) return;
    const p = pairs.data.find((x) => x.title === pendingPair);
    useSettingsUi.getState().clearPendingPair();
    if (p) {
      setServerError(null);
      setEditor({ form: pairToForm(p), id: p.id });
    }
  }, [pendingPair, pairs.data]);

  // A role that names an agent changes that agent's "used by" list.
  const invalidate = [qk.pairs, qk.agents];
  const save = useAction(
    (a: { id: string | null; payload: Record<string, unknown> }) => (a.id ? api.pairs.update(a.id, a.payload) : api.pairs.create(a.payload)),
    { invalidate, quiet: true, success: (_r, a) => (a.id ? "Pair saved" : "Pair created") },
  );
  const fromRecipe = useAction((id: string) => api.pairs.fromRecipe(id), { invalidate, success: (r) => `Added “${(r as any).pair.title}”` });
  const remove = useAction((id: string) => api.pairs.remove(id), { invalidate, success: "Pair deleted" });

  const list = pairs.data ?? [];
  const newForm = useMemo(() => emptyPairForm(), []);

  const openNew = () => {
    setServerError(null);
    setEditor({ form: newForm, id: null });
  };
  const openEdit = (p: Pair) => {
    setServerError(null);
    setEditor({ form: pairToForm(p), id: p.id });
  };
  const duplicate = async (p: Pair) => {
    setServerError(null);
    setEditor({ form: { ...pairToForm(p), title: `${p.title} copy` }, id: null });
  };
  const del = async (p: Pair) => {
    if (await confirm({ title: `Delete “${p.title}”?`, description: "Sessions that already use it keep running; new ones can no longer pick it.", confirmLabel: "Delete", danger: true })) remove.mutate(p.id);
  };

  return (
    <PageShell
      title="Hydra pairs"
      description="Pick who leads and what its heads run on. A lead opens heads as live subagents, reviews their work and merges it; the pair is the operator's call and binds the lead."
      actions={
        <>
          <DropdownMenu
            align="end"
            trigger={
              <Button variant="outline" size="md">
                <Sparkles /> From a recipe
              </Button>
            }
            entries={(recipes.data ?? []).map((r) => ({ label: `${r.title}: ${r.tagline}`, onSelect: () => fromRecipe.mutate(r.id) }))}
          />
          <Button variant="primary" size="md" onClick={openNew}>
            <Plus /> New pair
          </Button>
        </>
      }
    >
      {pairs.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col gap-4">
          <Empty icon={<Layers />} title="No pairs yet" hint="Start from a recipe, or build your own." className="rounded-xl border border-dashed border-line py-8" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-3">
            {(recipes.data ?? []).map((r, i) => (
              <RecipeCard key={r.id} recipe={r} delay={i * 40} onUse={() => fromRecipe.mutate(r.id)} />
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-3">
          {list.map((p, i) => (
            <PairCard key={p.id} pair={p} engines={engines.data} delay={i * 35} onEdit={() => openEdit(p)} onDuplicate={() => duplicate(p)} onDelete={() => del(p)} />
          ))}
        </div>
      )}

      <PairEditor
        open={!!editor}
        initial={editor?.form ?? newForm}
        editing={!!editor?.id}
        engines={engines.data ?? []}
        presets={roles.data ?? []}
        agents={agents.data ?? []}
        saving={save.isPending}
        serverError={serverError}
        onClose={() => setEditor(null)}
        onSave={(payload) => {
          setServerError(null);
          save.mutate(
            { id: editor?.id ?? null, payload },
            {
              onSuccess: () => setEditor(null),
              onError: (e) => setServerError(e.message),
            },
          );
        }}
      />
    </PageShell>
  );
}
