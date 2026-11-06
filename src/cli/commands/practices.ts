/**
 * `trb practices`: the practice packs of the project in the current directory, from a terminal.
 *
 *   trb practices ls [--json]              every pack, and whether it is on here
 *   trb practices enable <id..>            turn packs on (AGENTS.md / CLAUDE.md get their rules)
 *   trb practices disable <id..>           turn packs off
 *   trb practices enforce <off|warn|fix>   what a finding does after a turn here (warn: reported only; fix: sent back)
 *   trb practices check [--all] [--json]   findings of the enabled packs: the uncommitted files, or the whole repo with --all
 *   trb practices new --file <pack.json>   a new custom pack (the JSON of its fields: id, title, summary, appliesTo, rules, skills)
 *   trb practices edit <id> --file <f>     replace a pack's fields; a built-in pack becomes modified. --file - reads stdin
 *   trb practices reset <id>               a built-in pack back to what shipped
 *   trb practices rm <id>                  remove a custom pack
 *
 * `check` exits 1 when it finds something, so it can gate a script.
 */
import path from "path";
import { opts } from "../args";
import { api } from "../client";
import { c, die, printJson, printLine, table } from "../fmt";

interface Pack {
  id: string;
  title: string;
  summary: string;
  appliesTo: string[];
  rules: string[];
  custom: boolean;
}
interface Settings {
  enabled: string[];
  thresholds: { maxFileLines: number; maxFunctionLines: number };
  enforce: string;
}
interface Finding {
  packId: string;
  check: string;
  file: string;
  line?: number;
  message: string;
}
interface Skipped {
  check: string | null;
  reason: string;
}

const USAGE = `Usage: trb practices <ls|enable|disable|enforce|check|new|edit|reset|rm>
  trb practices ls [--json]
  trb practices enable <id..>
  trb practices disable <id..>
  trb practices enforce <off|warn|fix>
  trb practices check [--all] [--json]
  trb practices new --file <pack.json>
  trb practices edit <id> --file <pack.json|->
  trb practices reset <id>
  trb practices rm <id>`;

const ENFORCE = ["off", "warn", "fix"];

async function workspaceId(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

export async function cmdPractices(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    all: { type: "boolean" },
    json: { type: "boolean" },
    file: { type: "string" },
  });
  const sub = positionals[0] ?? "ls";
  const ids = positionals.slice(1);
  switch (sub) {
    case "ls":
    case "list":
      return list(values.json === true);
    case "enable":
    case "disable":
      if (!ids.length) die(USAGE);
      return toggle(sub === "enable", ids);
    case "enforce":
      if (ids.length !== 1 || !ENFORCE.includes(ids[0]!)) die("Usage: trb practices enforce <off|warn|fix>");
      return enforce(ids[0]!);
    case "check":
      return check(values.all === true, values.json === true);
    case "new":
      if (ids.length || !values.file) die("Usage: trb practices new --file <pack.json>");
      return save("POST", "/api/practices/custom", values.file, "created");
    case "edit":
      if (ids.length !== 1 || !values.file) die("Usage: trb practices edit <id> --file <pack.json|->");
      return save("PUT", `/api/practices/packs/${encodeURIComponent(ids[0]!)}`, values.file, "saved");
    case "reset":
      if (ids.length !== 1) die("Usage: trb practices reset <id>");
      return reset(ids[0]!);
    case "rm":
      if (ids.length !== 1) die("Usage: trb practices rm <id>");
      return remove(ids[0]!);
    default:
      die(USAGE);
  }
}

/** The pack's JSON from a file, or from stdin for "-". A file that is not JSON is a usage error, not a server error. */
async function packFrom(file: string): Promise<unknown> {
  const text = file === "-" ? await Bun.stdin.text() : await Bun.file(path.resolve(file)).text().catch(() => die(`Cannot read ${file}.`));
  try {
    return JSON.parse(text);
  } catch {
    return die(`${file} is not JSON.`);
  }
}

async function save(method: "POST" | "PUT", route: string, file: string, done: string): Promise<number> {
  const body = await packFrom(file);
  const r = await api<{ pack: { id: string; title: string; modified?: boolean } }>(method, route, body);
  const kind = r.pack.modified ? "built-in pack, now modified" : "custom pack";
  return printLine(`${c.green("✓")} ${done} ${r.pack.id} (${kind}).`);
}

async function reset(id: string): Promise<number> {
  const r = await api<{ pack: { id: string } }>("POST", `/api/practices/packs/${encodeURIComponent(id)}/reset`);
  return printLine(`${c.green("✓")} reset ${r.pack.id} to what shipped.`);
}

async function remove(id: string): Promise<number> {
  await api("DELETE", `/api/practices/packs/${encodeURIComponent(id)}`);
  return printLine(`${c.green("✓")} removed ${id}.`);
}

async function enforce(mode: string): Promise<number> {
  const ws = await workspaceId();
  const saved = await api<Settings>("PUT", `/api/workspaces/${ws}/practices`, { enforce: mode });
  return printLine(`${c.green("✓")} practices enforce: ${mode}  (${saved.enabled.length ? `on: ${saved.enabled.join(", ")}` : "no packs on"})`);
}

async function list(asJson: boolean): Promise<number> {
  const ws = await workspaceId();
  const [{ packs }, settings] = await Promise.all([api<{ packs: Pack[] }>("GET", "/api/practices"), api<Settings>("GET", `/api/workspaces/${ws}/practices`)]);
  if (asJson) return printJson({ packs, enabled: settings.enabled });
  console.log(
    table(
      packs.map((p) => [settings.enabled.includes(p.id) ? c.green("on") : c.dim("off"), p.id, p.title, `${p.rules.length} rules`, p.appliesTo.join(", "), p.custom ? c.dim("custom") : ""]),
      ["", "ID", "TITLE", "RULES", "APPLIES TO", ""],
    ),
  );
  return 0;
}

async function toggle(on: boolean, ids: string[]): Promise<number> {
  const ws = await workspaceId();
  const current = await api<Settings>("GET", `/api/workspaces/${ws}/practices`);
  const enabled = new Set(current.enabled);
  for (const id of ids) {
    if (on) enabled.add(id);
    else enabled.delete(id);
  }
  const saved = await api<Settings>("PUT", `/api/workspaces/${ws}/practices`, { enabled: [...enabled] });
  return printLine(`${c.green("✓")} ${on ? "enabled" : "disabled"} ${ids.join(", ")}  (on: ${saved.enabled.join(", ") || "none"})`);
}

async function check(all: boolean, asJson: boolean): Promise<number> {
  const ws = await workspaceId();
  const r = await api<{ packs: string[]; checked: number; findings: Finding[]; skipped: Skipped[] }>("POST", `/api/workspaces/${ws}/practices/check`, all ? {} : { changed: true });
  if (asJson) {
    printJson(r.findings);
    return r.findings.length ? 1 : 0;
  }
  if (!r.packs.length) return printLine("No practice packs are on here. Turn some on with trb practices enable <id>.");
  const files = `${r.checked} file${r.checked === 1 ? "" : "s"}`;
  // The skipped note comes after the result. It is a note, not a finding, so the exit code does not change.
  const notes = r.skipped.map((s) => c.dim(s.reason));
  if (!r.findings.length) {
    printLine(`${c.green("✓")} ${files} checked against ${r.packs.join(", ")}: nothing found.`);
    notes.forEach((n) => console.log(n));
    return 0;
  }
  console.log(
    table(
      r.findings.map((f) => [f.packId, `${f.file}${f.line ? `:${f.line}` : ""}`, f.message]),
      ["PACK", "WHERE", "MESSAGE"],
    ),
  );
  printLine(`${r.findings.length} finding${r.findings.length === 1 ? "" : "s"} in ${files}.`);
  notes.forEach((n) => console.log(n));
  return 1;
}
