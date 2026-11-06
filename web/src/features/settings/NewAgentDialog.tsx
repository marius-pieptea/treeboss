/**
 * Create an agent from anywhere (the pair editor's role cards use it) without leaving the page. It is the same
 * editor and the same endpoint as the Agents page, hosted as a dialog on top of whatever is open.
 */
import { useEffect, useState } from "react";
import { useAgents, useEngines, qk } from "@/lib/queries";
import type { Agent } from "@/lib/types";
import { api, keys, useAction, useMcp, useRoles, useSkills } from "./data";
import { AgentEditor } from "./AgentEditor";
import { emptyAgentForm, type AgentForm } from "./agents-logic";

export function NewAgentDialog({ open, initial, onClose, onCreated }: { open: boolean; initial?: AgentForm | null; onClose: () => void; onCreated: (agent: Agent) => void }) {
  const agents = useAgents();
  const engines = useEngines();
  const roles = useRoles();
  const skills = useSkills();
  const mcp = useMcp();
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setServerError(null);
  }, [open]);
  const save = useAction((payload: Record<string, unknown>) => api.agents.create(payload), { invalidate: [qk.agents, qk.pairs, keys.skills], quiet: true, success: "Agent created" });

  return (
    <AgentEditor
      open={open}
      initial={initial ?? emptyAgentForm()}
      editing={false}
      existing={(agents.data ?? []).map((a) => a.name)}
      engines={engines.data ?? []}
      presets={roles.data ?? []}
      skills={(skills.data ?? []).map((s) => ({ name: s.name, description: s.description, enabled: s.enabled }))}
      mcp={(mcp.data ?? []).map((s) => ({ name: s.name, description: s.transport === "stdio" ? [s.command, ...s.args].join(" ") : (s.url ?? ""), enabled: s.enabled }))}
      loadingAssignables={skills.isLoading || mcp.isLoading}
      saving={save.isPending}
      serverError={serverError}
      onClose={onClose}
      onSave={(payload) => {
        setServerError(null);
        save.mutate(payload, { onSuccess: (r) => onCreated(r.agent), onError: (e) => setServerError(e.message) });
      }}
    />
  );
}
