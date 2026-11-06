/**
 * `trb docs`: the project's documentation from a terminal.
 *
 *   trb docs ls                          pages, with how fresh each one is
 *   trb docs stale                       only the pages that have drifted, with the files that changed
 *   trb docs new <path> [-t "<title>"]   a new page from the template; `--adr "<title>"` for a decision record
 *   trb docs init                        create the docs folder with an index page (only when you say so)
 *   trb docs current <page>              record that the page is up to date as of HEAD
 *   trb docs generate [kind]            write or refresh pages with an agent (kinds: overview, architecture,
 *                                        module, conventions, runbook, adr); --page <path> (repeatable),
 *                                        --stale for every page that has drifted
 *   trb docs attach <session> <page> [--inline]
 *
 * The project is the current directory. The docs folder is `docs/` unless the workspace says otherwise.
 */
import path from "path";
import { opts } from "../args";
import { api, resolveSessionId } from "../client";
import { c, die, printJson, printLine, table } from "../fmt";
import { watch } from "./session";

interface Page {
  path: string;
  title: string;
  kind: string;
  managed: boolean;
  frontMatterError: string | null;
}
interface Staleness {
  state: string;
  reason: string | null;
  commitsBehind: number;
  filesChanged: number;
  files: Array<{ path: string; status: string }>;
  generatedCommit: string | null;
}
interface Overview {
  dir: string;
  exists: boolean;
  pages: Page[];
  nextAdr: string;
}

const COLOR: Record<string, (s: string) => string> = { fresh: c.green, drifting: c.yellow, stale: c.red, unknown: c.dim, unmanaged: c.dim };

const USAGE = `Usage: trb docs <ls|stale|new|init|current|generate|attach> …
  trb docs ls
  trb docs stale
  trb docs new <path> [-t "<title>"]        trb docs new --adr "<title>"
  trb docs init
  trb docs current <page>
  trb docs generate [overview|architecture|module|conventions|runbook|adr] [--page <path>]… [--stale] [-i "<note>"] [-e engine] [-m model] [-a agent] [--plan] [-d]
  trb docs attach <session> <page> [--inline]`;

async function workspaceRoot(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

export async function cmdDocs(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    title: { type: "string", short: "t" },
    adr: { type: "string" },
    page: { type: "string", multiple: true },
    stale: { type: "boolean" },
    input: { type: "string", short: "i" },
    engine: { type: "string", short: "e" },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    agent: { type: "string", short: "a" },
    pair: { type: "string", short: "p" },
    session: { type: "string", short: "s" },
    plan: { type: "boolean" },
    inline: { type: "boolean" },
    detach: { type: "boolean", short: "d" },
    json: { type: "boolean" },
  });
  const sub = positionals[0];
  if (!sub) die(USAGE);
  const root = await workspaceRoot();
  const follow = async (id: string): Promise<number> => (values.detach ? printLine(id) : watch(id, { tree: true, json: false, interruptOnSigint: true }));

  switch (sub) {
    case "ls":
    case "list": {
      const r = await api<{ docs: Overview; head: string | null; staleness: Record<string, Staleness> }>("GET", `/api/docs/${root}`);
      if (values.json) return printJson(r);
      if (!r.docs.exists) {
        console.log(c.dim(`no ${r.docs.dir}/ folder yet: trb docs init, or trb docs generate overview`));
        return 0;
      }
      if (!r.docs.pages.length) {
        console.log(c.dim(`${r.docs.dir}/ has no markdown pages yet`));
        return 0;
      }
      const rows = r.docs.pages.map((p) => {
        const st = r.staleness[p.path];
        const state = st?.state ?? "unmanaged";
        const note = st ? (st.state === "fresh" ? "" : st.state === "unknown" || st.state === "unmanaged" ? c.dim(st.reason ?? "") : `${st.filesChanged} files in ${st.commitsBehind} commits`) : "";
        return [p.path, (COLOR[state] ?? c.dim)(state), note, p.title];
      });
      console.log(table(rows, ["page", "freshness", "since written", "title"]));
      return 0;
    }

    case "stale": {
      const r = await api<{ docs: Overview; staleness: Record<string, Staleness> }>("GET", `/api/docs/${root}`);
      const drifted = r.docs.pages.filter((p) => ["stale", "drifting"].includes(r.staleness[p.path]?.state ?? ""));
      if (values.json) return printJson(drifted.map((p) => ({ page: p.path, ...r.staleness[p.path] })));
      if (!drifted.length) {
        console.log(c.green("every page that makes a claim is up to date"));
        return 0;
      }
      for (const p of drifted) {
        const st = r.staleness[p.path];
        console.log(`${COLOR[st.state](st.state.padEnd(8))} ${c.bold(p.path)}  ${st.filesChanged} covered files changed in ${st.commitsBehind} commits since ${st.generatedCommit?.slice(0, 8)}`);
        for (const f of st.files.slice(0, 6)) console.log(`           ${c.dim(f.status.padEnd(8))} ${f.path}`);
        if (st.files.length > 6) console.log(c.dim(`           … ${st.filesChanged - 6} more`));
      }
      console.error(c.dim("refresh them: trb docs generate --stale"));
      return 0;
    }

    case "new": {
      const kind = values.adr !== undefined ? "adr" : "page";
      const rel = positionals[1];
      if (kind === "page" && !rel) die(USAGE);
      const r = await api<{ path: string; title: string }>("POST", `/api/docs/${root}/pages`, { path: rel, title: values.adr ?? values.title, kind });
      if (values.json) return printJson(r);
      console.log(`created ${c.bold(r.path)}`);
      return 0;
    }

    case "init": {
      const r = await api<{ dir: string; created: string[] }>("POST", `/api/docs/${root}/folder`, {});
      if (values.json) return printJson(r);
      console.log(r.created.length ? `created ${c.bold(r.dir)}/ with ${r.created.join(", ")}` : `${r.dir}/ already has pages: nothing created`);
      return 0;
    }

    case "current": {
      if (!positionals[1]) die("Usage: trb docs current <page>");
      const r = await api<{ head: string }>("POST", `/api/docs/${root}/page/current`, { path: positionals[1] });
      console.log(`${positionals[1]} is recorded as current as of ${r.head.slice(0, 8)}`);
      return 0;
    }

    case "generate": {
      const kind = positionals[1] ?? (values.stale || values.page?.length ? "refresh" : "overview");
      const body = {
        kind,
        page: kind !== "refresh" ? values.page?.[0] : undefined,
        pages: kind === "refresh" && values.page?.length ? values.page : undefined,
        stale: values.stale === true,
        input: values.input,
        engine: values.engine,
        model: values.model,
        effort: values.effort,
        agent: values.agent,
        pairId: values.pair,
        sessionId: values.session ? await resolveSessionId(values.session) : undefined,
        planFirst: values.plan === true,
      };
      const r = await api<{ session: { id: string }; targets: Array<{ path: string; exists: boolean; state?: string }> }>("POST", `/api/docs/${root}/generate`, body);
      if (values.json) return printJson(r);
      console.error(c.dim(r.targets.length ? `${r.targets.map((t) => `${t.exists ? "refreshing" : "writing"} ${t.path}`).join(", ")}` : "writing a decision record"));
      const code = await follow(r.session.id);
      if (!values.detach) {
        const run = await api<{ run: { result: { touched: Array<{ path: string; issues: Array<{ message: string }> }>; stray: string[] } | null } }>("GET", `/api/docs/${root}/runs/${r.session.id}`).catch(() => null);
        for (const t of run?.run.result?.touched ?? []) {
          console.error(`${c.green("wrote")} ${t.path}`);
          for (const i of t.issues) console.error(`  ${c.yellow("!")} ${i.message}`);
        }
        if (run?.run.result?.stray.length) console.error(c.yellow(`files outside the docs folder changed: ${run.run.result.stray.join(", ")}`));
        console.error(c.dim("review with `git diff`, then commit"));
      }
      return code;
    }

    case "attach": {
      if (positionals.length < 3) die("Usage: trb docs attach <session> <page> [--inline]");
      const id = await resolveSessionId(positionals[1]);
      const r = await api<{ estimate: { tokens: number } }>("POST", `/api/sessions/${id}/docs`, { path: positionals[2], mode: values.inline ? "inline" : "ref" });
      if (values.json) return printJson(r);
      console.log(`attached ${c.bold(positionals[2])} to ${id} (${values.inline ? "pasted in full" : "by reference"}, about ${r.estimate.tokens} tokens in all)`);
      return 0;
    }

    default:
      die(USAGE);
  }
}
