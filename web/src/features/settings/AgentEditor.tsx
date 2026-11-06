import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DropdownMenu } from "@/components/ui/overlay";
import { Field, Input, Textarea } from "@/components/ui/form";
import { EngineModelEffort } from "./model-fields";
import { confirm } from "@/components/ui/dialogs";
import { cn } from "@/lib/utils";
import type { EngineInfo, RolePreset } from "@/lib/types";
import { applyTemplate, formToAgentPayload, instructionsCount, normalizeAgentName, previewAssignment, seesSummary, validateAgentForm, type AgentForm } from "./agents-logic";
import { AssignmentPicker, type AssignItem } from "./AssignmentPicker";
import { ErrorNote } from "./shared";

export function AgentEditor({ open, initial, editing, existing, engines, presets, skills, mcp, loadingAssignables, saving, serverError, onClose, onSave }: { open: boolean; initial: AgentForm; editing: boolean; existing: string[]; engines: EngineInfo[]; presets: RolePreset[]; skills: AssignItem[]; mcp: AssignItem[]; loadingAssignables?: boolean; saving: boolean; serverError: string | null; onClose: () => void; onSave: (payload: Record<string, unknown>) => void }) {
  const [form, setForm] = useState<AgentForm>(initial);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setForm(initial);
      setTouched(false);
    }
  }, [open, initial]);

  const set = (p: Partial<AgentForm>) => setForm((f) => ({ ...f, ...p }));
  const errors = useMemo(() => validateAgentForm(form, { editing, existing }), [form, editing, existing]);
  const count = instructionsCount(form.instructions);
  const sees = useMemo(
    () => seesSummary(previewAssignment(form.skillsMode === "all" ? null : form.skillsMode === "none" ? [] : form.skills, skills), previewAssignment(form.mcpMode === "all" ? null : form.mcpMode === "none" ? [] : form.mcp, mcp)),
    [form.skillsMode, form.skills, form.mcpMode, form.mcp, skills, mcp],
  );
  const slug = normalizeAgentName(form.name);

  const useTemplate = async (t: RolePreset) => {
    if (form.instructions.trim() && form.instructions !== t.instructions) {
      const ok = await confirm({ title: `Replace the instructions with the ${t.label} template?`, description: "What you have written in the instructions box will be overwritten.", confirmLabel: "Replace" });
      if (!ok) return;
    }
    setForm((f) => applyTemplate(f, t, { lockName: editing }));
  };

  const submit = () => {
    setTouched(true);
    if (errors.length) return;
    onSave(formToAgentPayload(form));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={720}
      title={editing ? `Edit ${form.title || form.name}` : "New agent"}
      description="A specialized agent is who a session runs as: standing instructions plus the skills and MCP servers it may use. Instructions are given once, when a conversation starts."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Create agent"}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[66vh] flex-col gap-4 overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint={editing ? "The name is fixed once created." : slug && slug !== form.name.trim() ? `Saved as “${slug}”` : "Used with --agent and subagent_create: lowercase, digits, - and _"}>
            <Input autoFocus={!editing} disabled={editing} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="reviewer" spellCheck={false} className="font-mono text-xs" />
          </Field>
          <Field label="Title" hint="Shown in lists and in the agent's own prompt.">
            <Input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Code reviewer" />
          </Field>
        </div>
        <Field label="Description" hint="One line. A lead reads it to decide which agent fits a slice of work.">
          <Input value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Reviews a diff for bugs and risk. Does not rewrite." />
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Instructions</span>
            <DropdownMenu
              align="end"
              trigger={
                <Button variant="outline" size="xs">
                  <Sparkles /> Start from a template <ChevronDown />
                </Button>
              }
              entries={presets.map((p) => ({ label: `${p.label}: ${p.description}`, onSelect: () => void useTemplate(p) }))}
            />
          </div>
          <Textarea
            value={form.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            rows={11}
            spellCheck={false}
            aria-label="Instructions"
            placeholder={"Who this agent is and how it works. For example:\n\nReview, don't rewrite. Read the diff and the code around it. Report concrete bugs, most severe first, each with file:line and a one-line fix."}
            className="min-h-[200px] font-mono text-[12px] leading-relaxed"
          />
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-fg-faint">Given once when a conversation starts; a resumed turn already knows it.</span>
            <span className="flex-1" />
            <span className={cn("font-mono tabular-nums", count.over ? "text-red" : count.near ? "text-amber" : "text-fg-faint")} aria-live="polite">
              {count.used.toLocaleString()} / {count.limit.toLocaleString()}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Defaults</span>
          <EngineModelEffort engines={engines} engine={form.engine} model={form.model} effort={form.effort} emptyEngineLabel="no preference" onChange={(p) => set({ engine: p.engine, model: p.model, effort: p.effort })} />
          <p className="text-[11px] text-fg-faint">Defaults only: an explicit choice, and a Hydra pair's own configuration, win over them.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Skills</span>
            <AssignmentPicker noun="skill" items={skills} mode={form.skillsMode} selected={form.skills} loading={loadingAssignables} onChange={(n) => set({ skillsMode: n.mode, skills: n.selected })} />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">MCP servers</span>
            <AssignmentPicker noun="MCP server" items={mcp} mode={form.mcpMode} selected={form.mcp} loading={loadingAssignables} onChange={(n) => set({ mcpMode: n.mode, mcp: n.selected })} />
          </div>
        </div>
        <p className="rounded-md border border-line bg-raised/50 px-3 py-2 text-xs text-fg-muted" aria-live="polite">
          {sees}. A disabled skill or server stays off even when assigned.
        </p>

        {touched && errors.length > 0 && <ErrorNote>{errors.map((e) => e.charAt(0).toUpperCase() + e.slice(1)).join(". ")}.</ErrorNote>}
        {serverError && <ErrorNote>{serverError}</ErrorNote>}
      </div>
    </Dialog>
  );
}
