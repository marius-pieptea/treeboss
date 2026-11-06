/**
 * `trb handoff` and `trb compact`: shrink a long session's context two ways. Compact asks the engine to
 * summarize in place; handoff starts a fresh session that carries only a summary.
 */
import { opts } from "../args";
import { api, resolveSessionId } from "../client";
import { c, die, printJson, printLine } from "../fmt";
import { watch } from "./session";

export async function cmdHandoff(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    engine: { type: "string", short: "e" },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    agent: { type: "string", short: "a" },
    pair: { type: "string", short: "p" },
    instructions: { type: "string", short: "i" },
    print: { type: "boolean" },
    "no-model": { type: "boolean" },
    detach: { type: "boolean", short: "d" },
    json: { type: "boolean" },
  });
  if (!positionals[0]) die('Usage: trb handoff <session> [-e engine] [-m model] [-a agent] [-i "what to do next"] [--print] [--no-model] [-d]');
  const id = await resolveSessionId(positionals[0]);

  if (values.print) {
    const r = await api<{ summary: string; method: string; note?: string }>("POST", `/api/sessions/${id}/handoff`, { preview: true, model_summary: !values["no-model"] });
    if (values.json) return printJson(r);
    if (r.note) console.error(c.dim(r.note));
    return printLine(r.summary);
  }

  const r = await api<{ session: { id: string; title: string }; method: string }>("POST", `/api/sessions/${id}/handoff`, {
    engine: values.engine,
    model: values.model,
    effort: values.effort,
    agent: values.agent,
    pair: values.pair,
    instructions: values.instructions,
    model_summary: !values["no-model"],
  });
  if (values.json) return printJson(r);
  console.error(c.dim(`handed off ${id} → ${r.session.id} (summary: ${r.method === "model" ? "written by the session" : r.method === "edited" ? "as given" : "built from its log"})`));
  if (values.detach) return printLine(r.session.id);
  return watch(r.session.id, { tree: true, json: false, interruptOnSigint: true });
}

export async function cmdCompact(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { detach: { type: "boolean", short: "d" }, json: { type: "boolean" } });
  if (!positionals[0]) die("Usage: trb compact <session>");
  const id = await resolveSessionId(positionals[0]);
  await api("POST", `/api/sessions/${id}/compact`, {});
  if (values.detach) return printLine(id);
  return watch(id, { tree: false, json: values.json === true, interruptOnSigint: true });
}
