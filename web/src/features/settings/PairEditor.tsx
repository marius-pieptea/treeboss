import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ExternalLink, Minus, Plus, RotateCcw, Trash2, TriangleAlert, UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DropdownMenu } from "@/components/ui/overlay";
import { Field, Input, Select, Switch, Textarea, type Option } from "@/components/ui/form";
import { EngineModelEffort } from "./model-fields";
import { Badge, SegTabs } from "@/components/ui/misc";
import { inheritHint, inheritedEffort, inheritedEngine, inheritedModel, type InheritContext } from "@/lib/models";
import { cn } from "@/lib/utils";
import type { Agent, EngineInfo, RolePreset } from "@/lib/types";
import { useUi } from "@/lib/store";
import { LEAD_INSTRUCTIONS_MAX, MAX_HEADS, normalizeRoleKey, presetAgentConflict, presetOfRole, switchPairMode, validatePairForm, withAgent, formToPayload, type PairForm, type RoleForm } from "./logic";
import { ErrorNote, WarnNote } from "./shared";
import { NewAgentDialog } from "./NewAgentDialog";
import { applyTemplate, assignmentLabel, emptyAgentForm, type AgentForm } from "./agents-logic";

const NEW_AGENT = "__new_agent__";

/** "1,204 chars · skills: all enabled · MCP: 2 servers": what an agent brings, in one line. */
function agentSummary(a: Agent): string {
  const instr = a.instructions.trim() ? `${a.instructions.length.toLocaleString()} chars of instructions` : "no instructions";
  return `${instr} · ${assignmentLabel(a.skills, "skill")} · ${assignmentLabel(a.mcp, "MCP server")}`;
}

/**
 * Which specialized agent a role's heads run as. It leads the card because it decides the most: the agent's
 * instructions, skills and MCP servers, and (where the role leaves them blank) its engine, model and effort.
 */
function AgentSelect({ value, agents, onChange, onCreate }: { value: string; agents: Agent[]; onChange: (name: string) => void; onCreate: () => void }) {
  const current = agents.find((a) => a.name === value);
  const missing = !!value && !current;
  const options: Option[] = [{ value: "", label: "no agent: a plain role" }, ...agents.map((a) => ({ value: a.name, label: a.title, hint: a.name }))];
  if (missing) options.push({ value, label: value, hint: "missing" });
  options.push({ value: NEW_AGENT, label: <span className="flex items-center gap-1.5 text-accent"><Plus className="size-3" /> Create new agent…</span> });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[130px_1fr] items-center gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
          <UserRoundCog className="size-3" /> Agent
        </span>
        <Select value={value} onChange={(v) => (v === NEW_AGENT ? onCreate() : onChange(v))} options={options} aria-label="Agent" className="flex-1" />
      </div>
      {current && (
        <div className="ml-[138px] flex items-start gap-2 rounded-md border border-line bg-bg/40 px-2.5 py-1.5 animate-slide-up">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{current.title}</div>
            {current.description && <div className="truncate text-[11px] text-fg-muted">{current.description}</div>}
            <div className="mt-0.5 text-[10.5px] text-fg-faint">{agentSummary(current)}</div>
          </div>
          <Button variant="ghost" size="xs" onClick={() => useUi.getState().openTab({ kind: "settings", page: "agents", title: "Agents" })}>
            <ExternalLink /> Open
          </Button>
        </div>
      )}
      {missing && <WarnNote>There is no agent “{value}”. Saving will be refused until you pick one that exists or clear this.</WarnNote>}
    </div>
  );
}

function RoleCard({ role, preset, engines, agents, lead, onChange, onRemove, onCreateAgent }: { role: RoleForm; preset: RolePreset | undefined; engines: EngineInfo[]; agents: Agent[]; lead: { engine: string; model: string; effort: string }; onChange: (r: RoleForm) => void; onRemove: () => void; onCreateAgent: () => void }) {
  const [open, setOpen] = useState(false);
  const key = normalizeRoleKey(role.key);
  const agent = agents.find((a) => a.name === role.agent) ?? null;
  const agentMissing = !!role.agent && !agent;
  const conflict = presetAgentConflict(role, preset, agent?.title ?? null);

  // Where each blank field gets its value from. A by-role pair has no heads config, so the order here is
  // role, then the agent, then the lead.
  const ctx: InheritContext = { heads: null, agent: agent ? { title: agent.title, engine: agent.engine, model: agent.model, effort: agent.effort } : null, lead };
  const eng = inheritedEngine(role, ctx);
  const hints = {
    engine: role.engine ? undefined : inheritHint(eng),
    model: role.model ? undefined : inheritHint(inheritedModel(role, ctx)),
    effort: role.effort ? undefined : inheritHint(inheritedEffort(role, ctx)),
  };
  return (
    <div className="rounded-lg border border-line bg-raised/50 p-2.5 animate-slide-up">
      <div className="mb-2 flex items-center gap-2">
        <Input value={role.key} onChange={(e) => onChange({ ...role, key: e.target.value })} placeholder="role name" spellCheck={false} className="h-7 w-40 font-mono text-xs" aria-label="Role name" />
        {key && key !== role.key.trim() && <span className="font-mono text-[10px] text-fg-faint">→ {key}</span>}
        <Input value={role.label} onChange={(e) => onChange({ ...role, label: e.target.value })} placeholder="label" title="Shown to the lead next to the role name; a preset or pstack name (worker, explorer) also finds this role by its label" className="h-7 w-28 text-xs" aria-label="Role label" />
        {agentMissing && (
          <Badge tone="amber" title={`This role names the agent “${role.agent}”, which no longer exists`}>
            <TriangleAlert className="size-2.5" /> agent missing
          </Badge>
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">{preset?.description}</span>
        <Button variant="ghost" size="xs" onClick={() => setOpen(!open)} aria-expanded={open}>
          Instructions
          <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
        </Button>
        <Button variant="dangerGhost" size="icon-sm" onClick={onRemove} aria-label={`Remove role ${role.key || ""}`}>
          <Trash2 />
        </Button>
      </div>
      <AgentSelect value={role.agent} agents={agents} onChange={(a) => onChange(withAgent(role, a, preset))} onCreate={onCreateAgent} />
      {conflict && (
        <WarnNote>
          {conflict}{" "}
          <Button variant="ghost" size="xs" onClick={() => onChange({ ...role, instructions: "" })}>
            Clear the preset text
          </Button>
        </WarnNote>
      )}
      <div className="mt-2">
        <EngineModelEffort engines={engines} engine={role.engine} effectiveEngine={eng.value} model={role.model} effort={role.effort} hints={hints} onChange={(p) => onChange({ ...role, ...p })} />
        <p className="mt-1.5 text-[10.5px] leading-snug text-fg-faint">A value set here wins. Blank fields come from {agent ? `the agent “${agent.title}”, then ` : ""}the lead's own engine, model and effort.</p>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5 animate-slide-up">
          {agent && (
            <details className="rounded-md border border-line bg-raised px-2 py-1 text-xs text-fg-faint">
              <summary className="cursor-pointer">The agent “{agent.title}” instructions, sent first</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono">{agent.instructions.trim() || "(none)"}</pre>
            </details>
          )}
          <Textarea value={role.instructions} onChange={(e) => onChange({ ...role, instructions: e.target.value })} placeholder={agent ? `Added after the agent “${agent.title}” instructions` : "Standing instructions for every head opened in this role"} className="min-h-24 text-xs" aria-label="Instructions" />
          {agent && <p className="text-xs text-fg-faint">Appended to the agent's instructions above, for every head in this role.</p>}
          {preset && role.instructions !== preset.instructions && (
            <Button variant="ghost" size="xs" className="self-start" onClick={() => onChange({ ...role, instructions: preset.instructions })}>
              <RotateCcw /> Reset to the library text
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function PairEditor({ open, initial, editing, engines, presets, agents, saving, serverError, onClose, onSave }: { open: boolean; initial: PairForm; editing: boolean; engines: EngineInfo[]; presets: RolePreset[]; agents: Agent[]; saving: boolean; serverError: string | null; onClose: () => void; onSave: (payload: Record<string, unknown>) => void }) {
  const [form, setForm] = useState<PairForm>(initial);
  const [touched, setTouched] = useState(false);
  // Creating an agent from a role card (or from a library preset) happens in a dialog on top of this one.
  const [creating, setCreating] = useState<{ initial: AgentForm; done: (a: Agent) => void } | null>(null);
  useEffect(() => {
    if (open) {
      setForm(initial);
      setTouched(false);
      setCreating(null);
    }
  }, [open, initial]);

  const errors = useMemo(() => validatePairForm(form), [form]);
  const set = (p: Partial<PairForm>) => setForm((f) => ({ ...f, ...p }));
  const usedKeys = new Set(form.roles.map((r) => normalizeRoleKey(r.key)));

  const addRole = (preset?: RolePreset, agent = "") => {
    const r: RoleForm = preset ? { key: preset.id, engine: preset.engine, model: "", effort: preset.effort, agent, instructions: agent ? "" : preset.instructions, label: preset.label } : { key: "", engine: form.leadEngine, model: "", effort: "", agent, instructions: "", label: "" };
    set({ roles: [...form.roles, r] });
  };
  const lead = { engine: form.leadEngine, model: form.leadModel, effort: form.leadEffort };

  const submit = () => {
    setTouched(true);
    if (errors.length) return;
    onSave(formToPayload(form));
  };

  const cap = form.maxHeads !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={680}
      title={editing ? "Edit pair" : "New Hydra pair"}
      description="A pair says who leads, and what the heads it opens run on. The operator's choice binds the lead: it cannot swap a head's engine or model."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Create pair"}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[62vh] flex-col gap-4 overflow-y-auto pr-1">
        <Field label="Title">
          <Input autoFocus value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Opus leads Codex" onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Lead</span>
          <EngineModelEffort lead emptyEngineLabel="inherit" engines={engines} engine={form.leadEngine} model={form.leadModel} effort={form.leadEffort} onChange={(p) => set({ leadEngine: p.engine, leadModel: p.model, leadEffort: p.effort })} />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Lead instructions</span>
            <span className={cn("font-mono text-[length:var(--text-xs)]", form.leadInstructions.length > LEAD_INSTRUCTIONS_MAX ? "text-red" : "text-fg-muted")}>
              {form.leadInstructions.length.toLocaleString()} / {LEAD_INSTRUCTIONS_MAX.toLocaleString()}
            </span>
          </div>
          <Textarea value={form.leadInstructions} onChange={(e) => set({ leadInstructions: e.target.value })} placeholder="How the lead splits the work, when it opens a reviewer, what it checks before a merge." className="min-h-16 text-xs" aria-label="Lead instructions" />
          <p className="text-xs text-fg-muted">A standing brief for the lead, read at the start of every turn after the pair's own rules. It shapes how the lead works, not what the heads do.</p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Heads</span>
            <SegTabs
              className="w-52"
              value={form.mode}
              onChange={(m) => setForm(switchPairMode(form, m))}
              items={[
                { value: "heads", label: "All the same" },
                { value: "roles", label: "By role" },
              ]}
            />
          </div>
          {form.mode === "heads" ? (
            <>
              <p className="text-xs text-fg-muted">Every head runs this config.</p>
              <EngineModelEffort engines={engines} engine={form.headsEngine} model={form.headsModel} effort={form.headsEffort} onChange={(p) => set({ headsEngine: p.engine, headsModel: p.model, headsEffort: p.effort })} />
            </>
          ) : (
            <>
              <p className="text-xs text-fg-muted">Every head names a role and runs that role's config. The lead picks the role when it opens a head.</p>
              <div className="flex flex-col gap-2">
                {form.roles.map((r, i) => (
                  <RoleCard key={i} role={r} preset={presetOfRole(r, presets)} engines={engines} agents={agents} lead={lead} onCreateAgent={() => setCreating({ initial: emptyAgentForm(), done: (a) => set({ roles: form.roles.map((x, j) => (j === i ? { ...x, agent: a.name } : x)) }) })} onChange={(nr) => set({ roles: form.roles.map((x, j) => (j === i ? nr : x)) })} onRemove={() => set({ roles: form.roles.filter((_, j) => j !== i) })} />
                ))}
              </div>
              <DropdownMenu
                trigger={
                  <Button variant="outline" size="sm" className="self-start">
                    <Plus /> Add role <ChevronDown />
                  </Button>
                }
                entries={[
                  ...presets.filter((p) => !usedKeys.has(p.id)).map((p) => ({ label: `${p.label}: ${p.description}`, onSelect: () => addRole(p) })),
                  { separator: true },
                  { label: "Custom role…", onSelect: () => addRole() },
                  {
                    label: "Create a role as an agent…",
                    icon: <UserRoundCog />,
                    children: presets.map((p) => ({
                      label: `${p.label}: ${p.description}`,
                      onSelect: () => setCreating({ initial: applyTemplate(emptyAgentForm(), p), done: (a) => addRole(p, a.name) }),
                    })),
                  },
                ]}
              />
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Switch checked={cap} onChange={(on) => set({ maxHeads: on ? 4 : null })} label="Cap open heads" />
          <span className="text-[13px]">Cap open heads</span>
          {cap && (
            <div className="ml-2 flex items-center gap-1 animate-slide-right">
              <Button variant="outline" size="icon-sm" aria-label="Fewer" onClick={() => set({ maxHeads: Math.max(MAX_HEADS.min, (form.maxHeads ?? 4) - 1) })}>
                <Minus />
              </Button>
              <span className="w-6 text-center font-mono text-[13px]">{form.maxHeads}</span>
              <Button variant="outline" size="icon-sm" aria-label="More" onClick={() => set({ maxHeads: Math.min(MAX_HEADS.max, (form.maxHeads ?? 4) + 1) })}>
                <Plus />
              </Button>
            </div>
          )}
          {!cap && <span className="text-xs text-fg-faint">No cap beyond the daemon's own limits.</span>}
        </div>

        {touched && errors.length > 0 && <ErrorNote>{errors.map((e) => e.charAt(0).toUpperCase() + e.slice(1)).join(". ")}.</ErrorNote>}
        {serverError && <ErrorNote>{serverError}</ErrorNote>}
      </div>
      <NewAgentDialog
        open={!!creating}
        initial={creating?.initial}
        onClose={() => setCreating(null)}
        onCreated={(a) => {
          creating?.done(a);
          setCreating(null);
        }}
      />
    </Dialog>
  );
}
