/**
 * `trb checklist`: launch checklists for the project in the current directory, and the catalog they come from. The checks run
 * in the daemon.
 *
 *   trb checklist ls [--json]                          the checklists (built-in, modified or custom), and which are attached here
 *   trb checklist attach <id>                          attach one
 *   trb checklist detach <id>
 *   trb checklist show <id> [--json]                   each item: status, kind, evidence, note
 *   trb checklist check [--url U] [--json]             run the automatic checks; --url is a running dev server or a deploy URL
 *   trb checklist tick <id> <item> [--note N] [--untick]
 *   trb checklist fix <id>                             start a fix session with the failing and judgement items; prints its id
 *   trb checklist audit [<id>] [--fix]                 start an agent audit of every open item (or one checklist's); --fix fixes failing items first; prints its id
 *   trb checklist stack [--json]                       the stack the folder is (nextjs, php-slim-twig, ...) and the evidence for it
 *
 * The catalog (every project):
 *   trb checklist new <id> [--from <id>] [--file F]    a new checklist: opens its JSON in $EDITOR, or reads --file. --from copies another one
 *   trb checklist edit <id> [--file F]                 the checklist's JSON in $EDITOR, or from --file; saved on exit
 *   trb checklist reset <id>                           a built-in back to what shipped
 *   trb checklist rm <id>                              delete a custom checklist (a built-in is reset instead)
 *
 * Per project, for an attached checklist:
 *   trb checklist item add <id> --text T --category C --kind agent|manual [--severity required|recommended] [--hint H] [--item-id I]
 *   trb checklist item disable <id> <item> [--enable]  an item that does not apply to this project (status n/a) or back on; not a required one
 *   trb checklist item rm <id> <item>                  remove a project-only item
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { opts } from "../args";
import { api } from "../client";
import { c, die, printJson, printLine, table } from "../fmt";

type Status = "pass" | "fail" | "unknown" | "na";
interface Item {
  id: string;
  text: string;
  category: string;
  severity: "required" | "recommended";
  kind: "auto" | "agent" | "manual";
  hint: string;
  status: Status;
  source: "auto" | "agent" | "manual" | null;
  evidence: string | null;
  message: string | null;
  reason: string | null;
  note: string | null;
  custom?: boolean;
}
interface Stack {
  stack: string;
  templateExts: string[];
  evidence: string[];
}
interface Attached {
  id: string;
  title: string;
  items: Item[];
  progress: { total: number; passing: number; requiredTotal: number; requiredPassing: number };
}
interface Catalog {
  id: string;
  title: string;
  summary: string;
  appliesTo: string[];
  items: Array<Omit<Item, "status" | "source" | "evidence" | "message" | "reason" | "note">>;
  builtin?: boolean;
  modified?: boolean;
}

const USAGE = `Usage: trb checklist ls | attach <id> | detach <id> | show <id> | check [--url U] | tick <id> <item> [--note N] [--untick] | fix <id> | audit [<id>] [--fix] | stack | new <id> | edit <id> | reset <id> | rm <id> | item add|disable|rm <id> ...`;

const STATUS = (s: Status) => (s === "pass" ? c.green("pass   ") : s === "fail" ? c.red("fail   ") : s === "na" ? c.dim("n/a    ") : c.dim("unknown"));

async function workspaceBase(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return `/api/workspaces/${r.workspace.id}/checklists`;
}

/** A path as one word of a shell command line. The editor runs through a shell, so it may be a command with flags ("code --wait"). */
const shellWord = (p: string): string => (process.platform === "win32" ? `"${p}"` : `'${p.replace(/'/g, "'\\''")}'`);

/** The JSON the operator edits, in $EDITOR (or notepad or vi). Nothing is saved when the editor fails or the JSON does not parse. */
export function editJson(initial: unknown): unknown {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-checklist-"));
  const file = path.join(dir, "checklist.json");
  try {
    fs.writeFileSync(file, JSON.stringify(initial, null, 2) + "\n");
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
    const r = spawnSync(editor, [shellWord(file)], { stdio: "inherit", shell: true });
    if (r.status !== 0) die(`The editor exited with ${r.status}. Nothing was saved.`);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err: any) {
      die(`The JSON does not parse, so nothing was saved: ${err.message}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A checklist's JSON from --file, or edited in $EDITOR from `initial`. */
function fromFileOrEditor(file: string | undefined, initial: unknown): unknown {
  if (!file) return editJson(initial);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err: any) {
    return die(`${file} does not parse as JSON: ${err.message}`);
  }
}

/** The definition without the flags the catalog adds: what PUT takes. */
const asDefinition = ({ builtin: _b, modified: _m, ...rest }: Catalog & { builtin?: boolean; modified?: boolean }) => rest;

export async function cmdChecklist(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    url: { type: "string" },
    note: { type: "string" },
    untick: { type: "boolean" },
    fix: { type: "boolean" },
    json: { type: "boolean" },
    from: { type: "string" },
    file: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    applies: { type: "string" },
    text: { type: "string" },
    category: { type: "string" },
    severity: { type: "string" },
    kind: { type: "string" },
    hint: { type: "string" },
    "item-id": { type: "string" },
    enable: { type: "boolean" },
  });
  const sub = positionals[0] ?? "ls";
  const [, a, b] = positionals;
  const ws = async () => workspaceBase();

  switch (sub) {
    case "ls":
    case "list": {
      const [{ checklists: catalog }, { checklists: attached }] = await Promise.all([api<{ checklists: Catalog[] }>("GET", "/api/checklists/catalog"), api<{ checklists: Attached[] }>("GET", await ws())]);
      const on = new Set(attached.map((x) => x.id));
      if (values.json) return printJson({ catalog, attached: [...on] });
      console.log(table(catalog.map((x) => [on.has(x.id) ? c.green("attached") : c.dim("-"), x.id, x.title, c.dim(`${x.items.length} items`), x.modified ? c.dim("modified") : x.builtin === false ? c.dim("custom") : ""]), ["", "id", "checklist", "", ""]));
      return 0;
    }
    case "attach": {
      if (!a) die("Usage: trb checklist attach <id>");
      const { checklist } = await api<{ checklist: Attached }>("POST", await ws(), { checklistId: a });
      return printLine(`${c.green("attached")} ${checklist.id}: ${checklist.progress.requiredPassing} of ${checklist.progress.requiredTotal} required items passing. Run: trb checklist check`);
    }
    case "detach": {
      if (!a) die("Usage: trb checklist detach <id>");
      await api("DELETE", `${await ws()}/${encodeURIComponent(a)}`);
      return printLine(`detached ${a}`);
    }
    case "show": {
      if (!a) die("Usage: trb checklist show <id>");
      const { checklists } = await api<{ checklists: Attached[] }>("GET", await ws());
      const one = checklists.find((x) => x.id === a);
      if (!one) die(`${a} is not attached here. Attach it: trb checklist attach ${a}`);
      if (values.json) return printJson(one);
      console.log(`${c.bold(one.title)}  ${c.dim(`${one.progress.requiredPassing}/${one.progress.requiredTotal} required, ${one.progress.passing}/${one.progress.total} all`)}`);
      console.log(table(one.items.map((i) => [STATUS(i.status), i.severity === "required" ? "required" : c.dim("recommended"), i.custom ? `${i.kind} ${c.dim("(custom)")}` : i.kind, i.id, i.source ? `${c.dim(`[${i.source}]`)} ${i.message ?? i.reason ?? ""}`.trimEnd() : c.dim("not checked"), i.note ? c.dim(i.note) : ""]), ["status", "severity", "kind", "item", "message", "note"]));
      return 0;
    }
    case "check": {
      const r = await api<{ ran: number; skipped: number; results: Array<{ checklistId: string; itemId: string; status: Status; message: string; evidence: string | null }>; screens: Array<{ checklistId: string; itemId: string; observed: string; applied: "refuted" | "withdrawn" | "checked" | "none"; reason: string; images: string[] }> }>("POST", `${await ws()}/run`, { url: values.url ?? null });
      if (values.json) return printJson(r);
      console.log(table(r.results.map((x) => [STATUS(x.status), `${x.checklistId}/${x.itemId}`, x.message]), ["status", "item", "message"]));
      console.log(c.dim(`${r.ran} checked${r.skipped ? `, ${r.skipped} ticked by hand and left alone` : ""}`));
      if (r.screens?.length) {
        console.log(`\nScreens (${values.url}, desktop 1440×900, mobile 390×844):`);
        for (const s of r.screens) {
          const verdict = s.applied === "refuted" ? c.red("refuted") : s.applied === "checked" ? c.green("checked") : s.applied === "withdrawn" ? c.green("withdrawn") : c.dim(s.observed);
          console.log(`  ${s.itemId.padEnd(18)} ${verdict}  ${s.reason}`);
          for (const img of s.images) console.log(c.dim(`  ${"".padEnd(18)} ${img}`));
        }
      }
      return r.results.some((x) => x.status === "fail") || r.screens?.some((s) => s.applied === "refuted") ? 1 : 0;
    }
    case "tick": {
      if (!a || !b) die("Usage: trb checklist tick <checklist> <item> [--note N] [--untick]");
      const body: Record<string, unknown> = { checked: values.untick !== true };
      if (values.note !== undefined) body.note = values.note;
      const { item } = await api<{ item: Item }>("PATCH", `${await ws()}/${encodeURIComponent(a)}/items/${encodeURIComponent(b)}`, body);
      return printLine(`${item.id}: ${item.status === "pass" ? c.green("ticked") : "unticked"}${item.note ? ` · ${c.dim(item.note)}` : ""}`);
    }
    case "fix": {
      if (!a) die("Usage: trb checklist fix <id>");
      const { sessionId } = await api<{ sessionId: string }>("POST", `${await ws()}/${encodeURIComponent(a)}/fix`, {});
      return printLine(sessionId);
    }
    case "audit": {
      const { sessionId } = await api<{ sessionId: string }>("POST", `${await ws()}/audit`, { checklistId: a ?? null, fix: values.fix === true });
      return printLine(sessionId);
    }
    case "stack": {
      const s = await api<Stack>("GET", `${await ws()}/stack`);
      if (values.json) return printJson(s);
      console.log(`${c.bold(s.stack)}${s.templateExts.length ? c.dim(`  templates: ${s.templateExts.join(", ")}`) : ""}`);
      for (const e of s.evidence) console.log(c.dim(`  ${e}`));
      return 0;
    }

    /* The catalog */
    case "new": {
      if (!a) die("Usage: trb checklist new <id> [--from <id>] [--file F]");
      const from = values.from ?? null;
      let starter: Record<string, unknown> = { id: a, title: "New checklist", summary: "", appliesTo: [], items: [{ id: "first-item", text: "Describe what must be true", category: "General", severity: "recommended", kind: "manual", hint: "What to do when it does not hold." }] };
      if (from) {
        const { checklist } = await api<{ checklist: Catalog }>("GET", `/api/checklists/catalog/${encodeURIComponent(from)}`);
        starter = { ...asDefinition(checklist), id: a, title: `${checklist.title} (copy)` };
      }
      const definition = fromFileOrEditor(values.file, values.title || values.summary || values.applies ? { ...starter, ...(values.title ? { title: values.title } : {}), ...(values.summary !== undefined ? { summary: values.summary } : {}), ...(values.applies ? { appliesTo: values.applies.split(",").map((s) => s.trim()).filter(Boolean) } : {}) } : starter);
      const body = from ? { ...(definition as object), forkOf: from } : definition;
      const { checklist } = await api<{ checklist: Catalog }>("POST", "/api/checklists/catalog", body);
      return printLine(`${c.green("created")} ${checklist.id}: ${checklist.items.length} items. Attach it in a project with: trb checklist attach ${checklist.id}`);
    }
    case "edit": {
      if (!a) die("Usage: trb checklist edit <id> [--file F]");
      const { checklist } = await api<{ checklist: Catalog }>("GET", `/api/checklists/catalog/${encodeURIComponent(a)}`);
      const definition = fromFileOrEditor(values.file, asDefinition(checklist));
      const { checklist: saved } = await api<{ checklist: Catalog }>("PUT", `/api/checklists/catalog/${encodeURIComponent(a)}`, definition);
      return printLine(`${c.green("saved")} ${saved.id}: ${saved.items.length} items`);
    }
    case "reset": {
      if (!a) die("Usage: trb checklist reset <id>");
      await api("POST", `/api/checklists/catalog/${encodeURIComponent(a)}/reset`, {});
      return printLine(`${a} is back to its default`);
    }
    case "rm": {
      if (!a) die("Usage: trb checklist rm <id>");
      await api("DELETE", `/api/checklists/catalog/${encodeURIComponent(a)}`);
      return printLine(`deleted ${a}`);
    }

    /* Per project */
    case "item": {
      const action = positionals[1];
      const cid = positionals[2];
      const iid = positionals[3];
      if (action === "add") {
        const id = cid;
        if (!id || !values.text || !values.category || !values.kind) die("Usage: trb checklist item add <id> --text T --category C --kind agent|manual [--severity required|recommended] [--hint H] [--item-id I]");
        const body = { text: values.text, category: values.category, kind: values.kind, severity: values.severity ?? "recommended", hint: values.hint ?? "", ...(values["item-id"] ? { id: values["item-id"] } : {}) };
        const { item } = await api<{ item: Item }>("POST", `${await ws()}/${encodeURIComponent(id)}/items`, body);
        return printLine(`${c.green("added")} ${item.id} to ${id} for this project`);
      }
      if (action === "disable") {
        if (!cid || !iid) die("Usage: trb checklist item disable <id> <item> [--enable]");
        const { item } = await api<{ item: Item }>("PATCH", `${await ws()}/${encodeURIComponent(cid)}/items/${encodeURIComponent(iid)}`, { disabled: values.enable !== true });
        return printLine(`${item.id}: ${item.status === "na" ? c.dim("disabled for this project") : "back on"}`);
      }
      if (action === "rm") {
        if (!cid || !iid) die("Usage: trb checklist item rm <id> <item>");
        await api("DELETE", `${await ws()}/${encodeURIComponent(cid)}/items/${encodeURIComponent(iid)}`);
        return printLine(`removed ${iid} from ${cid} for this project`);
      }
      return die("Usage: trb checklist item add <id> ... | item disable <id> <item> [--enable] | item rm <id> <item>");
    }
    default:
      die(USAGE);
  }
}
