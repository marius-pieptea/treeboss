import { useEffect, useMemo, useState } from "react";
import { BookOpen, Blocks, Copy, FileText, Pencil, Plus, RotateCcw, Sparkles, Trash2, UserRoundCog } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { Button, IconButton } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/overlay";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { confirm } from "@/components/ui/dialogs";
import { useGlow } from "@/lib/hooks";
import { qk, useAgents, useEngines, useMissingBuiltinAgents } from "@/lib/queries";
import { useUi } from "@/lib/store";
import type { Agent, RolePreset } from "@/lib/types";
import { agentToForm, assignmentLabel, emptyAgentForm, instructionsPreview, normalizeAgentName, type AgentForm } from "./agents-logic";
import { api, keys, useAction, useMcp, useRoles, useSkills } from "./data";
import { AgentEditor } from "./AgentEditor";
import { EngineChip, PageShell } from "./shared";
import { DIALOG_PAGE, useSettingsUi } from "./ui-state";

function AgentCard({ agent, onEdit, onDuplicate, onDelete, onReset, delay }: { agent: Agent; onEdit: () => void; onDuplicate: () => void; onDelete: () => void; onReset: () => void; delay: number }) {
  const glow = useGlow();
  const hasDefaults = agent.engine || agent.model || agent.effort;
  return (
    <div {...glow} style={{ animationDelay: `${delay}ms` }} className="glow-surface group animate-slide-up rounded-xl border border-line bg-bg/40 p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-[14px] font-semibold">{agent.title}</h3>
            <span className="truncate font-mono text-[11px] text-fg-faint">{agent.name}</span>
          </div>
          <p className="mt-0.5 line-clamp-2 min-h-[1.2em] text-[12.5px] leading-snug text-fg-muted">{agent.description || <span className="text-fg-faint">No description</span>}</p>
        </div>
        <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconButton label="Edit" size="icon-sm" onClick={onEdit}>
            <Pencil />
          </IconButton>
          <IconButton label="Duplicate" size="icon-sm" onClick={onDuplicate}>
            <Copy />
          </IconButton>
          {agent.builtin && (
            <IconButton label="Reset to default" size="icon-sm" onClick={onReset} disabled={!agent.modified} title={agent.modified ? "Put the version that ships with trb back" : "Already the shipped version"}>
              <RotateCcw />
            </IconButton>
          )}
          <IconButton label="Delete" size="icon-sm" variant="dangerGhost" onClick={onDelete}>
            <Trash2 />
          </IconButton>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {agent.builtin && (
          <Badge tone="accent" title={agent.modified ? "Ships with trb. You changed it; Reset puts the shipped version back." : "Ships with trb. Edit it freely; Reset puts the shipped version back."}>
            {agent.modified ? "Built-in, edited" : "Built-in"}
          </Badge>
        )}
        {hasDefaults && <EngineChip id={agent.engine} model={agent.model} effort={agent.effort} />}
        <Badge tone={agent.skills === null ? "neutral" : agent.skills.length ? "accent" : "amber"} title={agent.skills ? agent.skills.join(", ") || "No skills" : "The default skills (the default_skills setting)"}>
          <BookOpen className="size-2.5" /> {assignmentLabel(agent.skills, "skill")}
        </Badge>
        <Badge tone={agent.mcp === null ? "neutral" : agent.mcp.length ? "accent" : "amber"} title={agent.mcp ? agent.mcp.join(", ") || "No MCP servers" : "Every enabled MCP server"}>
          <Blocks className="size-2.5" /> {assignmentLabel(agent.mcp, "MCP server")}
        </Badge>
        {agent.instructions.trim() ? (
          <Badge title={`${agent.instructions.length.toLocaleString()} characters of instructions`}>
            <FileText className="size-2.5" /> {agent.instructions.length.toLocaleString()} chars
          </Badge>
        ) : (
          <Badge tone="amber" title="With no instructions, this agent only changes what it can use">
            no instructions
          </Badge>
        )}
        {agent.used_by_pairs.map((u) => (
          <button
            key={`${u.pair}/${u.role}`}
            onClick={() => {
              useSettingsUi.getState().openPair(u.pair);
              useUi.getState().openTab({ kind: "settings", page: "pairs", title: "Hydra pairs" });
            }}
            title={`Runs the “${u.role}” heads of the pair “${u.pair}”. Open the pair.`}
            className="rounded outline-none transition-transform hover:scale-[1.03] focus-visible:ring-1 focus-visible:ring-accent"
          >
            <Badge tone="violet" className="cursor-pointer">
              {u.pair} / {u.role}
            </Badge>
          </button>
        ))}
      </div>
      {agent.instructions.trim() && <p className="mt-2.5 border-t border-line pt-2 font-mono text-[11px] leading-relaxed text-fg-faint">{instructionsPreview(agent.instructions)}</p>}
    </div>
  );
}

function TemplateTile({ role, onUse, delay, busy }: { role: RolePreset; onUse: () => void; delay: number; busy: boolean }) {
  const glow = useGlow();
  return (
    <button {...glow} disabled={busy} onClick={onUse} style={{ animationDelay: `${delay}ms` }} className="glow-surface animate-slide-up flex flex-col gap-1 rounded-xl border border-line bg-bg/40 p-3 text-left outline-none transition-[border-color,transform] hover:border-line-strong focus-visible:border-accent/60 active:scale-[0.99] disabled:opacity-50">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <Sparkles className="size-3.5 text-accent" />
        {role.label}
      </div>
      <div className="text-xs text-fg-muted">{role.description}</div>
    </button>
  );
}

export function AgentsPage() {
  const qc = useQueryClient();
  const agents = useAgents();
  const missingBuiltins = useMissingBuiltinAgents();
  const engines = useEngines();
  const roles = useRoles();
  const skills = useSkills();
  const mcp = useMcp();
  const dialog = useSettingsUi((s) => s.dialog);
  const closeDialog = useSettingsUi((s) => s.close);

  const [editor, setEditor] = useState<{ form: AgentForm; editing: boolean } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const list = agents.data ?? [];
  const existing = useMemo(() => list.map((a) => a.name), [list]);

  // "New agent…" from the command palette lands here.
  useEffect(() => {
    if (dialog && DIALOG_PAGE[dialog] === "agents") {
      setServerError(null);
      setEditor({ form: emptyAgentForm(), editing: false });
      closeDialog();
    }
  }, [dialog, closeDialog]);

  // Saving an agent can change what a pair role shows ("used by") and which skills say they are in use.
  const invalidate = [qk.agents, qk.pairs, keys.skills];
  const save = useAction((a: { editing: boolean; payload: Record<string, unknown> }) => (a.editing ? api.agents.update(String(a.payload.name), a.payload) : api.agents.create(a.payload)), { invalidate, quiet: true, success: (_r, a) => (a.editing ? "Agent saved" : "Agent created") });
  const fromRole = useAction((role: RolePreset) => api.agents.fromRole(role.id, uniqueName(role.id, existing)), { invalidate, success: (r) => `Created “${(r as any).agent.title}”` });
  const resetAgent = useAction((a: Agent) => api.agents.reset(a.name), { invalidate, success: (_r, a) => `${a.title} is back to the version that ships with trb` });
  const restore = useAction(() => api.agents.restoreBuiltins(), { invalidate, success: (r) => (r.added.length ? `Restored ${r.added.join(", ")}` : "Nothing to restore") });

  const openNew = () => {
    setServerError(null);
    setEditor({ form: emptyAgentForm(), editing: false });
  };
  const openEdit = (a: Agent) => {
    setServerError(null);
    setEditor({ form: agentToForm(a), editing: true });
  };
  const duplicate = (a: Agent) => {
    setServerError(null);
    setEditor({ form: { ...agentToForm(a), name: uniqueName(`${a.name}-copy`, existing), title: `${a.title} copy` }, editing: false });
  };

  const del = async (a: Agent) => {
    const used = a.used_by_pairs.length > 0;
    const usage = used ? `It is used by ${a.used_by_pairs.map((u) => `${u.pair} / ${u.role}`).join(", ")}. You will be asked again before it is removed from those roles.` : "Sessions that already run as this agent keep running; new ones can no longer pick it.";
    const ok = await confirm({
      title: `Delete “${a.title}”?`,
      description: a.builtin ? `${usage} It ships with trb: Restore built-in agents brings it back.` : usage,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.agents.remove(a.name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // The daemon refuses while a pair role still uses it; say so in its words and offer to go ahead.
        const force = await confirm({ title: "Delete it anyway?", description: `${e.message} A role that names a deleted agent keeps working, as a plain role.`, confirmLabel: "Delete anyway", danger: true });
        if (!force) return;
        try {
          await api.agents.remove(a.name, true);
        } catch (e2) {
          return void toast.error((e2 as Error).message);
        }
      } else return void toast.error((e as Error).message);
    }
    toast.success(`Deleted “${a.title}”`);
    for (const k of invalidate) void qc.invalidateQueries({ queryKey: k });
  };

  // A built-in you changed goes back to the shipped version. Asked first: the changes are not kept anywhere else.
  const reset = async (a: Agent) => {
    if (!(await confirm({ title: `Reset “${a.title}” to the version that ships with trb?`, description: "Your changes to its instructions, skills, MCP servers and defaults are replaced.", confirmLabel: "Reset", danger: true }))) return;
    resetAgent.mutate(a);
  };

  return (
    <PageShell
      title="Agents"
      description="A specialized agent is a profile a session can run as: its own standing instructions, and the skills and MCP servers it may use. Start a session as one, open a head as one, or give a Hydra pair role one."
      actions={
        <>
          {!!missingBuiltins.data?.length && (
            <Button variant="outline" size="md" onClick={() => restore.mutate()} disabled={restore.isPending} title={`Adds back: ${missingBuiltins.data.join(", ")}`} data-agents-restore>
              <RotateCcw /> Restore built-in agents ({missingBuiltins.data.length})
            </Button>
          )}
          <DropdownMenu
            align="end"
            trigger={
              <Button variant="outline" size="md">
                <Sparkles /> From a template
              </Button>
            }
            entries={(roles.data ?? []).map((r) => ({ label: `${r.label}: ${r.description}`, onSelect: () => fromRole.mutate(r) }))}
          />
          <Button variant="primary" size="md" onClick={openNew}>
            <Plus /> New agent
          </Button>
        </>
      }
    >
      {agents.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col gap-4">
          <Empty icon={<UserRoundCog />} title="No agents yet" hint="Start from a template below, or write your own." className="rounded-xl border border-dashed border-line py-8" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2.5">
            {(roles.data ?? []).map((r, i) => (
              <TemplateTile key={r.id} role={r} delay={i * 25} busy={fromRole.isPending} onUse={() => fromRole.mutate(r)} />
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-3">
          {list.map((a, i) => (
            <AgentCard key={a.name} agent={a} delay={i * 35} onEdit={() => openEdit(a)} onDuplicate={() => duplicate(a)} onDelete={() => void del(a)} onReset={() => void reset(a)} />
          ))}
        </div>
      )}

      <AgentEditor
        open={!!editor}
        initial={editor?.form ?? emptyAgentForm()}
        editing={!!editor?.editing}
        existing={existing}
        engines={engines.data ?? []}
        presets={roles.data ?? []}
        skills={(skills.data ?? []).map((s) => ({ name: s.name, description: s.description, enabled: s.enabled }))}
        mcp={(mcp.data ?? []).map((s) => ({ name: s.name, description: s.transport === "stdio" ? [s.command, ...s.args].join(" ") : (s.url ?? ""), enabled: s.enabled }))}
        loadingAssignables={skills.isLoading || mcp.isLoading}
        saving={save.isPending}
        serverError={serverError}
        onClose={() => setEditor(null)}
        onSave={(payload) => {
          setServerError(null);
          save.mutate({ editing: !!editor?.editing, payload }, { onSuccess: () => setEditor(null), onError: (e) => setServerError(e.message) });
        }}
      />
    </PageShell>
  );
}

/** A name not yet taken: "reviewer", then "reviewer-2", "reviewer-3"… */
function uniqueName(base: string, existing: string[]): string {
  const root = normalizeAgentName(base) || "agent";
  if (!existing.includes(root)) return root;
  for (let i = 2; i < 100; i++) if (!existing.includes(`${root.slice(0, 36)}-${i}`)) return `${root.slice(0, 36)}-${i}`;
  return root;
}

/** Open the agents page (used by links elsewhere). */
export function openAgentsPage(): void {
  useUi.getState().openTab({ kind: "settings", page: "agents", title: "Agents" });
}
