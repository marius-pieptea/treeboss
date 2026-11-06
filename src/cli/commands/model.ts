/**
 * `trb model <session> [<model>] [--effort e]`: show the model a session is on, or change it for its next turn.
 */
import { opts } from "../args";
import { api, resolveSessionId } from "../client";
import { c, die, printJson } from "../fmt";

interface View {
  id: string;
  engine: string;
  model: string | null;
  effort: string | null;
  model_lock: string | null;
  model_pending: boolean;
  status: string;
}

const line = (s: View): string => `${s.engine} · ${s.model ?? "default"}${s.effort ? ` · effort ${s.effort}` : ""}${s.model_pending ? c.dim("  (applies to the next turn)") : ""}${s.model_lock ? c.dim(`  [locked: ${s.model_lock}]`) : ""}`;

export async function cmdModel(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { effort: { type: "string" }, json: { type: "boolean" } });
  if (!positionals[0]) die("Usage: trb model <session> [<model>|default] [--effort <level>]");
  const id = await resolveSessionId(positionals[0]);
  const model = positionals[1];
  if (model === undefined && values.effort === undefined) {
    const s = (await api<{ session: View }>("GET", `/api/sessions/${id}`)).session;
    if (values.json) return printJson({ session: s }), 0;
    console.log(line(s));
    return 0;
  }
  const r = await api<{ session: View; from: string | null; to: string | null; warning: string | null; uncached_next_turn: boolean; context_tokens: number | null }>("PUT", `/api/sessions/${id}/model`, {
    ...(model !== undefined ? { model } : {}),
    ...(values.effort !== undefined ? { effort: values.effort } : {}),
  });
  if (values.json) return printJson(r), 0;
  console.log(line(r.session));
  if (r.warning) console.error(c.dim(r.warning));
  if (r.uncached_next_turn) console.error(c.dim(`the next turn re-reads the conversation without the cache${r.context_tokens ? ` (~${Math.round(r.context_tokens / 1000)}k tokens)` : ""}: it costs more once.`));
  return 0;
}
