/**
 * `trb evidence`: what agents captured and concluded in this project, from a terminal.
 *
 *   trb evidence [ls] [query…] [--kind page|note] [--json]
 *   trb evidence show <id> [--part styles|assets|network|snapshot|html|meta|console|note|result] [--json]
 *   trb evidence capture [--session <id>] [--label "<title>"]   capture the page open in a session's browser
 *   trb evidence note "<title>" --text "<finding>" [--ref <id>…]
 *   trb evidence export <id> [--path <page>]                    write it as a page in the project's docs folder
 *   trb evidence rm <id>
 *   trb evidence investigations [--json]                        the project's investigations, and what each holds
 *   trb evidence investigate "<title>" [--target <url|path|app>] [--kind auto|web|electron|binary|android|other] [--run]
 *   trb evidence run <inv> [-e engine] [-m model] [--note "<focus>"] [-d]   start a run on it and follow the session
 *   trb evidence close <inv> [--summary "<what was found>"]
 *   trb evidence findings [--status new|planned|built|dismissed] [--json]
 *   trb evidence status <id> new|planned|built|dismissed
 *   trb evidence build <id…> [--json]                           print the prompt that builds these findings
 *   trb evidence on|off                                          the evidence tools for sessions (on by default)
 *   trb evidence rea on|off|status                               REA, the third-party reverse-engineering MCP server (on by default)
 *
 * The project is the current directory.
 */
import path from "path";
import { opts } from "../args";
import { api, connect } from "../client";
import { c, die, printJson, printLine } from "../fmt";
import { watch } from "./session";
import { getSetting, setSetting } from "../../settings";
import { REA_VERSION, reaLaunch } from "../../evidence/rea";
import { describeCounts, type InvestigationCounts } from "../../evidence/investigations";

interface Item {
  id: string;
  kind: "page" | "note";
  title: string;
  url: string | null;
  summary: string;
  refs: string[];
  files: Record<string, number>;
  bytes: number;
  investigation_id: string | null;
  finding: "feature" | "ui" | null;
  finding_status: "new" | "planned" | "built" | "dismissed" | null;
  source: "browser" | "rea" | "agent" | "operator" | null;
  created_at: string;
}

interface Investigation {
  id: string;
  title: string;
  target: string | null;
  target_kind: string;
  kind_reason: string | null;
  status: "open" | "closed";
  summary: string;
  counts: InvestigationCounts;
  running: boolean;
}

interface RunSession {
  id: string;
  title: string;
}

const FINDING_STATUSES = ["new", "planned", "built", "dismissed"];
const TARGET_KINDS = ["auto", "web", "electron", "binary", "android", "other"];

const USAGE = `Usage: trb evidence [ls|show|capture|note|export|rm|investigations|investigate|close|findings|status|build|on|off|rea] …
  trb evidence ls [query…] [--kind page|note]
  trb evidence show <id> [--part styles|assets|network|snapshot|html|meta|console|note|result]
  trb evidence capture [--session <id>] [--label "<title>"]
  trb evidence note "<title>" --text "<finding>" [--ref <id>…]
  trb evidence export <id> [--path <page>]
  trb evidence rm <id>
  trb evidence investigations
  trb evidence investigate "<title>" [--target <url|path|app>] [--kind auto|web|electron|binary|android|other] [--run]
  trb evidence run <inv> [-e engine] [-m model] [--note "<focus>"] [-d]
  trb evidence close <inv> [--summary "<what was found>"]
  trb evidence findings [--status new|planned|built|dismissed]
  trb evidence status <id> new|planned|built|dismissed
  trb evidence build <id…>
  trb evidence on|off
  trb evidence rea on|off|status`;

const PART_FILE: Record<string, string> = { snapshot: "snapshot.txt", styles: "styles.json", assets: "assets.json", network: "network.json", html: "page.html", meta: "meta.json", console: "console.json", note: "note.md", screenshot: "screenshot.jpg" };

async function projectRoot(): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(process.cwd()) });
  return r.workspace.id;
}

function toggle(key: "evidence" | "rea_mcp", value: string): number {
  try {
    setSetting(key, value);
  } catch (err: any) {
    die(err.message);
  }
  console.log(`${key} = ${getSetting(key)}`);
  if (key === "rea_mcp" && value === "on") console.log(c.dim(`REA runs through ${reaLaunch() ? [reaLaunch()!.command, ...reaLaunch()!.args].join(" ") : "npx (not found: install Node, or set rea_command)"}: ${reaLaunch()?.source === "npx" ? "it downloads and runs that npm package" : "the pinned npm package is already installed, so nothing is downloaded"}.`));
  return 0;
}

export async function cmdEvidence(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    kind: { type: "string", short: "k" },
    part: { type: "string", short: "p" },
    session: { type: "string", short: "s" },
    label: { type: "string", short: "l" },
    text: { type: "string", short: "t" },
    ref: { type: "string", multiple: true },
    path: { type: "string" },
    target: { type: "string" },
    summary: { type: "string" },
    status: { type: "string" },
    engine: { type: "string", short: "e" },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    agent: { type: "string", short: "a" },
    pair: { type: "string" },
    note: { type: "string", short: "n" },
    run: { type: "boolean" },
    detach: { type: "boolean", short: "d" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "ls";
  const need = (what: string): string => positionals[1] ?? die(`Usage: trb evidence ${sub} <${what}>`);
  const who = { engine: values.engine, model: values.model, effort: values.effort, agent: values.agent, pairId: values.pair, note: values.note };
  const follow = (s: RunSession) => {
    console.error(c.dim(`${s.title} → ${s.id}`));
    return values.detach ? printLine(s.id) : watch(s.id, { tree: true, json: false, interruptOnSigint: true });
  };

  if (sub === "on" || sub === "off") return toggle("evidence", sub);
  if (sub === "rea") {
    const v = positionals[1] ?? "status";
    if (v === "on" || v === "off") return toggle("rea_mcp", v);
    if (v !== "status") die("Usage: trb evidence rea on|off|status");
    const launch = reaLaunch();
    console.log(`rea_mcp = ${getSetting("rea_mcp")}  (REA ${REA_VERSION}, MIT, third party: https://github.com/morluto/rea)`);
    console.log(launch ? `starts with: ${[launch.command, ...launch.args].join(" ")}` : c.yellow("cannot start: npx not found. Install Node, or set rea_command."));
    return 0;
  }

  const root = await projectRoot();
  const base = `/api/evidence/${root}`;

  switch (sub) {
    case "run": {
      const id = need("inv");
      const r = await api<{ investigation: Investigation; session: RunSession }>("POST", `${base}/investigations/${encodeURIComponent(id)}/run`, who);
      if (values.json) return printJson(r);
      return follow(r.session);
    }

    case "investigations": {
      const r = await api<{ investigations: Investigation[] }>("GET", `${base}/investigations`);
      if (values.json) return printJson(r.investigations);
      if (!r.investigations.length) {
        console.log(c.dim("no investigations yet: start one with `trb evidence investigate \"<title>\" --target <url>`"));
        return 0;
      }
      for (const i of r.investigations) {
        console.log(`${c.bold(i.id)}  ${i.status === "open" ? c.green("open") : c.dim("closed")}  ${i.title}${i.target ? c.dim(`  ${i.target_kind}: ${i.target}`) : ""}`);
        console.log(c.dim(`  ${describeCounts(i.counts)}`));
        if (i.summary) console.log(c.dim(`  ${i.summary.split("\n")[0]}`));
      }
      return 0;
    }

    case "investigate": {
      const title = need("title");
      const kind = values.kind ?? "auto";
      if (!TARGET_KINDS.includes(kind)) die(`--kind must be one of ${TARGET_KINDS.join(", ")}.`);
      const r = await api<{ investigation: Investigation; session: RunSession | null; runError?: string; detected: { kind: string; reason: string } | null }>("POST", `${base}/investigations`, { title, target: values.target ?? null, target_kind: kind, ...(values.run ? { run: true, ...who } : {}) });
      if (values.json) return printJson(r);
      console.log(`started ${c.bold(r.investigation.id)}  ${r.investigation.title}`);
      if (r.detected) console.log(c.dim(`  kind ${r.detected.kind}: ${r.detected.reason}`));
      if (!values.run) return 0;
      if (!r.session) die(`${r.runError} The investigation is kept: run it with trb evidence run ${r.investigation.id}.`);
      return follow(r.session);
    }

    case "close": {
      const id = need("inv");
      const body: Record<string, unknown> = { status: "closed" };
      if (values.summary !== undefined) body.summary = values.summary;
      const r = await api<{ investigation: Investigation }>("PATCH", `${base}/investigations/${encodeURIComponent(id)}`, body);
      if (values.json) return printJson(r.investigation);
      console.log(`closed ${c.bold(r.investigation.id)}  ${describeCounts(r.investigation.counts)}`);
      return 0;
    }

    case "findings": {
      const status = values.status;
      if (status !== undefined && !FINDING_STATUSES.includes(status)) die(`--status must be one of ${FINDING_STATUSES.join(", ")}.`);
      const q = new URLSearchParams({ finding: "any", ...(status ? { status } : {}) });
      const r = await api<{ items: Item[] }>("GET", `${base}?${q}`);
      if (values.json) return printJson(r.items);
      if (!r.items.length) {
        console.log(c.dim("no findings yet: agents record them with evidence_finding"));
        return 0;
      }
      for (const e of r.items) {
        console.log(`${c.bold(e.id)}  ${e.finding === "ui" ? "UI design" : "feature"}  ${e.finding_status}  ${e.title}${e.investigation_id ? c.dim(`  (${e.investigation_id})`) : ""}`);
        if (e.summary) console.log(c.dim(`  ${e.summary}`));
      }
      return 0;
    }

    case "status": {
      const id = need("id");
      const status = positionals[2] ?? die("Usage: trb evidence status <id> new|planned|built|dismissed");
      const r = await api<{ item: Item }>("PATCH", `${base}/${encodeURIComponent(id)}`, { finding_status: status });
      if (values.json) return printJson(r.item);
      console.log(`${c.bold(r.item.id)}  ${r.item.finding_status}`);
      return 0;
    }

    case "build": {
      const ids = positionals.slice(1);
      if (!ids.length) die("Usage: trb evidence build <id…>");
      const r = await api<{ prompt: string; ids: string[] }>("POST", `${base}/build`, { ids });
      if (values.json) return printJson(r);
      process.stdout.write(r.prompt);
      return 0;
    }

    case "ls":
    case "list": {
      const q = new URLSearchParams({ ...(positionals.length > 1 ? { q: positionals.slice(1).join(" ") } : {}), ...(values.kind ? { kind: values.kind } : {}) });
      const r = await api<{ enabled: boolean; items: Item[] }>("GET", `${base}?${q}`);
      if (values.json) return printJson(r.items);
      if (!r.enabled) console.log(c.yellow("evidence is off for sessions: trb evidence on"));
      if (!r.items.length) {
        console.log(c.dim("no evidence yet: agents add it with evidence_capture_page, or `trb evidence capture`"));
        return 0;
      }
      for (const e of r.items) {
        const finding = e.finding ? c.yellow(` ${e.finding} ${e.finding_status}`) : "";
        console.log(`${c.bold(e.id)}  ${c.cyan(e.kind)}${finding}  ${e.title}${e.url ? c.dim(`  ${e.url}`) : ""}`);
        if (e.summary) console.log(c.dim(`  ${e.summary}`));
      }
      return 0;
    }

    case "show": {
      const id = need("id");
      const r = await api<{ item: Item; cites: Item[]; citedBy: Item[] }>("GET", `${base}/${encodeURIComponent(id)}`);
      if (values.part) {
        const file = values.part === "result" ? ("rea.json" in r.item.files ? "rea.json" : "rea.txt") : (PART_FILE[values.part] ?? die(`Unknown part "${values.part}".`));
        if (!(file in r.item.files)) die(`${id} has no ${values.part}. Parts: ${Object.keys(r.item.files).join(", ")}.`);
        const { info, token } = await connect();
        const res = await fetch(`${info.url}${base}/${encodeURIComponent(id)}/file/${file}`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) die(`Could not read ${values.part} (${res.status}).`);
        process.stdout.write(Buffer.from(await res.arrayBuffer()));
        return 0;
      }
      if (values.json) return printJson(r);
      const e = r.item;
      console.log(`${c.bold(e.id)}  ${c.cyan(e.kind)}  ${e.title}`);
      if (e.url) console.log(e.url);
      console.log(c.dim(`${e.created_at} · ${Math.round(e.bytes / 1024)} KB · parts: ${Object.keys(e.files).join(", ")}`));
      if (e.summary) console.log(`\n${e.summary}`);
      if (r.cites.length) console.log(`\ncites: ${r.cites.map((x) => `${x.id} ${x.title}`).join("; ")}`);
      if (r.citedBy.length) console.log(`cited by: ${r.citedBy.map((x) => `${x.id} ${x.title}`).join("; ")}`);
      if (e.finding) console.log(`finding (${e.finding}): ${e.finding_status}`);
      return 0;
    }

    case "capture": {
      const session = values.session ?? die("Usage: trb evidence capture --session <id> (the session whose browser holds the page)");
      const r = await api<{ item: Item }>("POST", `${base}/capture`, { sessionId: session, label: values.label });
      if (values.json) return printJson(r.item);
      console.log(`${c.bold(r.item.id)}  ${r.item.title}\n${c.dim(r.item.summary)}`);
      return 0;
    }

    case "note": {
      const title = need("title");
      if (!values.text) die("A note needs --text.");
      const r = await api<{ item: Item }>("POST", `${base}/note`, { title, text: values.text, refs: values.ref ?? [] });
      if (values.json) return printJson(r.item);
      console.log(`saved ${c.bold(r.item.id)}`);
      return 0;
    }

    case "export": {
      const r = await api<{ page: { path: string } }>("POST", `${base}/${encodeURIComponent(need("id"))}/export`, { path: values.path });
      if (values.json) return printJson(r.page);
      console.log(`wrote ${r.page.path}`);
      return 0;
    }

    case "rm":
    case "remove": {
      const r = await api<{ removed: boolean }>("DELETE", `${base}/${encodeURIComponent(need("id"))}`);
      console.log(r.removed ? "removed" : "no such evidence");
      return r.removed ? 0 : 1;
    }

    default:
      die(USAGE);
  }
}
