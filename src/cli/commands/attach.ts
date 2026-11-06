/**
 * What a session has attached (specs, plans and docs), from the terminal.
 *
 *   trb attachments <session> <path>… [--inline]  attach files (the kind follows from the path)
 *   trb attachments <session> --detach <path>…    take them off
 *   trb attachments <session>                     list what is attached, with the cost
 *
 * `trb spec attach` and `trb docs attach` stay for their own workflows; this is the one that takes anything.
 */
import { opts } from "../args";
import { api, resolveSessionId } from "../client";
import { c, die, printJson, table } from "../fmt";

interface Row {
  path: string;
  kind: string;
  mode: string;
}
interface Listing {
  attached: Row[];
  estimate: { tokens: number; items: Array<{ path: string; tokens: number }> };
}

const USAGE = `Usage: trb attachments <session> [<path>…] [--inline] [--detach] [--json]
  trb attachments <session>                     what is attached, with the token cost
  trb attachments <session> <path>…             attach specs, plans or docs by reference
  trb attachments <session> <path>… --inline    paste them into the prompt instead
  trb attachments <session> <path>… --detach    take them off`;

export async function cmdAttachments(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { inline: { type: "boolean" }, detach: { type: "boolean", short: "d" }, json: { type: "boolean" } });
  if (!positionals.length) die(USAGE);
  const id = await resolveSessionId(positionals[0]);
  const paths = positionals.slice(1);

  let last: Listing | null = null;
  for (const p of paths) {
    if (values.detach) last = await api<Listing>("DELETE", `/api/sessions/${id}/attachments?path=${encodeURIComponent(p)}`);
    else last = await api<Listing>("POST", `/api/sessions/${id}/attachments`, { path: p, mode: values.inline ? "inline" : "ref" });
  }
  const list = await api<Listing>("GET", `/api/sessions/${id}/attachments`);
  if (values.json) return printJson(list);
  if (paths.length) console.log(`${values.detach ? "detached" : "attached"} ${paths.map((p) => c.bold(p)).join(", ")} ${values.detach ? "from" : "to"} ${id}`);
  void last;
  if (!list.attached.length) {
    console.log(c.dim("nothing attached"));
    return 0;
  }
  const cost = new Map(list.estimate.items.map((i) => [i.path, i.tokens]));
  console.log(table(list.attached.map((a) => [a.kind, a.path, a.mode === "inline" ? "pasted" : "pointer", `~${cost.get(a.path) ?? 0}`]), ["KIND", "PATH", "MODE", "TOKENS"]));
  console.log(c.dim(`about ${list.estimate.tokens} tokens in all`));
  return 0;
}
