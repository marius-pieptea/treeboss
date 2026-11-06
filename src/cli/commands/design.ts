/**
 * `trb design`: a project's design system (DESIGN.md + design/tokens.css) and the library, from a terminal.
 *
 *   trb design show [--json]                         the project's design: title, tokens, agent rule
 *   trb design systems [--json]                      the library: what New app and `apply` offer
 *   trb design apply <system> [--force]              write a library system into the project (--force replaces)
 *   trb design save "<name>" [-D "<description>"]    copy the project's files into the library
 *   trb design start <brief|url|codebase|wire|review> ["<input>"] [--no-brainstorm] [-e engine] [-m model] [-a agent] [-d]
 *
 * The project is the current directory.
 */
import path from "path";
import { opts } from "../args";
import { api, resolveSessionId } from "../client";
import { c, die, printJson, printLine } from "../fmt";
import { watch } from "./session";

interface Summary {
  colors: Array<{ name: string; light: string; dark: string | null }>;
  fonts: Array<{ name: string; value: string }>;
  count: number;
  missing: string[];
}
interface State {
  exists: boolean;
  path: string;
  title: string | null;
  tokens: { path: string; exists: boolean; summary: Summary | null };
  agentRule: boolean;
  matches: string | null;
}
interface SystemView {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  modified: boolean;
  summary: Summary;
}

const USAGE = `Usage: trb design <show|systems|apply|save|start> …
  trb design show
  trb design systems
  trb design apply <system> [--force]
  trb design save "<name>" [-D "<description>"]
  trb design start brief "<what the product is and how it should feel>" [--no-brainstorm]
  trb design start url https://example.com [--no-brainstorm]
      brief and url brainstorm first: questions and 2-3 directions (design/directions.html), then you reply with a pick
  trb design start codebase | wire | review ["<extra instructions>"]
      [-e engine] [-m model] [--effort E] [-a agent] [-p pair] [--session id] [--detach]`;

async function workspaceRoot(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

export async function cmdDesign(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    force: { type: "boolean", short: "f" },
    "no-brainstorm": { type: "boolean" },
    description: { type: "string", short: "D" },
    engine: { type: "string", short: "e" },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    agent: { type: "string", short: "a" },
    pair: { type: "string", short: "p" },
    session: { type: "string" },
    detach: { type: "boolean", short: "d" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "show";

  if (sub === "systems") {
    const r = await api<{ systems: SystemView[] }>("GET", "/api/design/systems");
    if (values.json) return printJson(r);
    for (const s of r.systems) {
      const tag = s.isDefault ? c.dim(s.modified ? " (edited default)" : " (default)") : "";
      printLine(`${c.bold(s.id.padEnd(14))} ${s.name}${tag}`);
      if (s.description) printLine(`  ${c.dim(s.description)}`);
    }
    return 0;
  }

  const root = await workspaceRoot();
  const base = `/api/design/${root}`;
  switch (sub) {
    case "show": {
      const r = await api<{ design: State }>("GET", base);
      if (values.json) return printJson(r);
      const d = r.design;
      if (!d.exists) {
        printLine(`No ${d.path} here. ${c.dim("trb design apply <system>  or  trb design start brief \"…\"")}`);
        return 0;
      }
      printLine(`${c.bold(d.title ?? d.path)}  ${c.dim(d.path)}${d.matches ? c.dim(`  (library: ${d.matches})`) : ""}`);
      const t = d.tokens.summary;
      if (!t) printLine(c.yellow(`  ${d.tokens.path} is missing`));
      else {
        printLine(`  ${d.tokens.path}: ${t.count} tokens, ${t.colors.length} colors`);
        for (const col of t.colors) printLine(`    ${col.name.padEnd(22)} ${col.light}${col.dark ? c.dim(` / ${col.dark}`) : ""}`);
        for (const f of t.fonts) printLine(`    ${f.name.padEnd(22)} ${c.dim(f.value)}`);
        if (t.missing.length) printLine(c.yellow(`  missing from the contract: ${t.missing.join(", ")}`));
      }
      printLine(d.agentRule ? c.dim("  AGENTS.md points agents at it.") : c.yellow("  AGENTS.md does not mention it yet (trb design apply, or add the rule in Memory)."));
      return 0;
    }
    case "apply": {
      const system = positionals[1];
      if (!system) die(USAGE);
      const r = await api<{ design: State }>("POST", `${base}/apply`, { system, overwrite: values.force === true });
      if (values.json) return printJson(r);
      printLine(`Wrote ${r.design.path}${r.design.tokens.exists ? ` and ${r.design.tokens.path}` : ""} from "${system}".`);
      return 0;
    }
    case "save": {
      const r = await api<{ system: { id: string; name: string } }>("POST", `${base}/save-to-library`, { name: positionals[1] ?? "", description: values.description });
      if (values.json) return printJson(r);
      printLine(`Saved to the library as ${c.bold(r.system.id)} (${r.system.name}).`);
      return 0;
    }
    case "start": {
      const kind = positionals[1];
      if (!kind) die(USAGE);
      const r = await api<{ session: { id: string; title: string } }>("POST", `${base}/start`, {
        kind,
        input: positionals.slice(2).join(" "),
        brainstorm: values["no-brainstorm"] !== true,
        engine: values.engine,
        model: values.model,
        effort: values.effort,
        agent: values.agent,
        pairId: values.pair,
        sessionId: values.session ? await resolveSessionId(values.session) : undefined,
      });
      if (values.json) return printJson(r);
      console.error(c.dim(`${r.session.title} → ${r.session.id}`));
      return values.detach ? printLine(r.session.id) : watch(r.session.id, { tree: true, json: false, interruptOnSigint: true });
    }
    default:
      die(USAGE);
  }
}
