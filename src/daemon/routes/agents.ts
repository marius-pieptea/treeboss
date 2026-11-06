/** Specialized agents: /api/agents */
import { Agents, type AgentRecord } from "../../agents/store";
import { builtinAgentStatus, claimBuiltinName, missingBuiltinAgents, resetBuiltinAgent, restoreBuiltinAgents } from "../../agents/builtin";
import { HttpError, json, type RouteModule } from "../http";

const view = (a: AgentRecord) => ({ ...a, used_by_pairs: Agents.usedByPairs(a.name), ...builtinAgentStatus(a) });

export const agentRoutes: RouteModule = (c) => {
  let m: RegExpMatchArray | null;
  if (c.path === "/api/agents" && c.method === "GET") return json({ agents: Agents.list().map(view), missingBuiltins: missingBuiltinAgents() });
  if (c.path === "/api/agents" && c.method === "POST") {
    const a = c.body.fromRole ? Agents.fromRole(String(c.body.fromRole), c.body.name ?? null) : Agents.create(c.body as any);
    claimBuiltinName(a.name);
    return json({ agent: view(a) }, 201);
  }
  if (c.path === "/api/agents/restore-builtins" && c.method === "POST") return json({ added: restoreBuiltinAgents() });
  if ((m = c.match(/^\/api\/agents\/([^/]+)\/reset$/)) && c.method === "POST") return json({ agent: view(resetBuiltinAgent(m[1])) });
  if ((m = c.match(/^\/api\/agents\/([^/]+)$/))) {
    const a = Agents.get(m[1]);
    if (!a) throw new HttpError(404, `No agent "${m[1]}".`);
    if (c.method === "GET") return json({ agent: view(a) });
    if (c.method === "PUT" || c.method === "PATCH") return json({ agent: view(Agents.update(a.name, c.body as any)) });
    if (c.method === "DELETE") {
      const users = Agents.usedByPairs(a.name);
      if (users.length && c.q("force") !== "1") {
        throw new HttpError(409, `Agent "${a.name}" is used by ${users.map((u) => `${u.pair}/${u.role}`).join(", ")}. Remove it from those roles first, or pass force=1.`);
      }
      return json({ removed: Agents.remove(a.name) });
    }
  }
  return null;
};
