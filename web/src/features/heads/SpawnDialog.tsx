import { useEffect, useMemo, useState } from "react";
import { Rocket, UserRoundCog } from "lucide-react";
import { Dialog } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { EffortSelect, ModelSelect } from "@/components/ui/model-select";
import { cachedCatalog, effortAfterEngineChange, loadCatalog, modelAfterEngineChange } from "@/lib/models";
import { useQueryClient } from "@tanstack/react-query";
import { SegTabs, Spinner } from "@/components/ui/misc";
import { useAgents, useEngines, usePairs } from "@/lib/queries";
import type { SessionView } from "@/lib/types";
import { RoleBadge } from "./RoleBadge";
import { pairRoles } from "./model";
import { useSpawnDialog } from "./spawn-store";
import type { HeadActions } from "./actions";
import { EngineIcon } from "@/components/ui/engine-icon";

/** Open a head by hand under the lead (or under one of its heads): a role from the pair, or an explicit engine. */
export function SpawnDialog({ lead, heads, actions }: { lead: SessionView | null; heads: SessionView[]; actions: HeadActions }) {
  const { open, parentId, hide } = useSpawnDialog();
  const pairs = usePairs();
  const engines = useEngines();
  const agents = useAgents();
  const qc = useQueryClient();
  const pair = pairs.data?.find((p) => p.id === lead?.pair) ?? null;
  const roles = useMemo(() => pairRoles(pair), [pair]);

  const [parent, setParent] = useState("");
  const [mode, setMode] = useState<"role" | "custom">("custom");
  const [role, setRole] = useState("");
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [agent, setAgent] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [isolate, setIsolate] = useState(true);
  const [busy, setBusy] = useState(false);

  // Fresh form each time it opens, seeded from the pair's heads config.
  useEffect(() => {
    if (!open) return;
    setParent(parentId ?? lead?.id ?? "");
    setMode(roles.length ? "role" : "custom");
    setRole(roles[0]?.id ?? "");
    setEngine(pair?.heads_engine ?? lead?.engine ?? "");
    setModel(pair?.heads_model ?? "");
    setEffort(pair?.heads_effort ?? "");
    setAgent("");
    setTitle("");
    setBrief("");
    setIsolate(true);
    setBusy(false);
  }, [open, parentId, lead?.id, lead?.engine, pair, roles]);

  if (!lead) return null;
  const installed = (engines.data ?? []).filter((e) => e.installed);
  const parents = [lead, ...heads.filter((h) => h.status !== "closed" && h.depth < 2)];
  const roleAgent = mode === "role" ? (roles.find((r) => r.id === role)?.agent ?? null) : null;
  const canSubmit = brief.trim().length > 0 && (mode === "role" ? !!role : !!engine) && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const s = await actions.spawn(parent || lead.id, {
      brief: brief.trim(),
      title: title.trim() || undefined,
      ...(mode === "role" ? { role } : { engine, model: model.trim() || undefined, effort: effort.trim() || undefined }),
      ...(agent ? { agent } : {}),
      isolate,
    });
    setBusy(false);
    if (s) hide();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && hide()}
      width={520}
      title="Spawn a head"
      description="A head is a live subagent with its own context. It works in an isolated worktree; you merge what you want to keep."
      footer={
        <>
          <Button variant="ghost" onClick={hide}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            {busy ? <Spinner className="text-accent-fg" /> : <Rocket />} Spawn
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {parents.length > 1 && <Field label="Under">
          <Select value={parent} onChange={setParent} options={parents.map((p) => ({ value: p.id, label: `${p.id === lead.id ? "lead" : (p.role ?? p.engine)}: ${p.title.length > 44 ? `${p.title.slice(0, 43)}…` : p.title}` }))} />
        </Field>}

        {roles.length > 0 && <SegTabs value={mode} onChange={setMode} items={[{ value: "role", label: "Pair role" }, { value: "custom", label: "Engine & model" }]} />}

        {mode === "role" && roles.length > 0 ? (
          <Field label="Role" hint="Runs the engine, model and effort the pair assigned to this role, with its standing instructions.">
            <Select
              value={role}
              onChange={setRole}
              options={roles.map((r) => ({
                value: r.id,
                label: (
                  <span className="flex items-center gap-2">
                    <RoleBadge role={r.id} /> {r.label}
                  </span>
                ),
                hint: [r.engine, r.model].filter(Boolean).join(" / "),
              }))}
            />
          </Field>
        ) : (
          <div className="grid grid-cols-[1fr_1.4fr_100px] gap-2">
            <Field label="Engine">
              <Select
                value={engine}
                onChange={(id) => {
                  // A model id means nothing to another engine: keep it only if the new engine lists it.
                  setEngine(id);
                  void (async () => {
                    const next = cachedCatalog(qc, id) ?? (await loadCatalog(qc, id));
                    setModel((m) => modelAfterEngineChange(m, next));
                    setEffort((e) => effortAfterEngineChange(e, next?.efforts));
                  })();
                }}
                options={installed.map((e) => ({ value: e.id, label: <span className="flex items-center gap-2"><EngineIcon engine={e.id} className="size-3.5" />{e.label}</span> }))}
                placeholder="Engine"
              />
            </Field>
            <Field label="Model">
              <ModelSelect engine={engine} value={model} onChange={setModel} placeholder="Engine default" />
            </Field>
            <Field label="Effort">
              <EffortSelect engine={engine} model={model} value={effort} onChange={setEffort} />
            </Field>
          </div>
        )}

        {(agents.data?.length ?? 0) > 0 && (
          <Field
            label="Agent (optional)"
            hint={
              roleAgent && !agent
                ? `This role already runs as “${roleAgent}”. Pick one here to use a different agent.`
                : agent
                  ? (agents.data?.find((a) => a.name === agent)?.description || "Its instructions, skills and MCP servers apply to this head.")
                  : "Run the head as a specialized agent: its instructions, skills and MCP servers apply."
            }
          >
            <Select
              value={agent}
              onChange={setAgent}
              options={[{ value: "", label: roleAgent ? `role default (${roleAgent})` : "no agent" }, ...(agents.data ?? []).map((a) => ({ value: a.name, label: <span className="flex items-center gap-2"><UserRoundCog className="size-3 text-fg-muted" />{a.title}</span>, hint: a.name }))]}
            />
          </Field>
        )}
        <Field label="Title (optional)">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short label" />
        </Field>
        <Field label="Brief" hint="Self-contained: the head does not see your conversation. Say what to do and what to report back.">
          <Textarea autoFocus value={brief} onChange={(e) => setBrief(e.target.value)} onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && submit()} rows={5} placeholder="Add input validation to src/greet.ts and update its tests…" />
        </Field>
        <label className="flex items-start gap-2.5 text-xs text-fg-muted">
          <span className="mt-0.5">
            <Switch checked={isolate} onChange={setIsolate} label="Isolate in a worktree" />
          </span>
          <span>
            Isolate in its own git worktree
            <span className="block text-fg-faint">Recommended: its changes come back through merge, never straight into your checkout.</span>
          </span>
        </label>
      </div>
    </Dialog>
  );
}
