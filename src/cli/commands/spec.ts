/**
 * `trb spec`: the specification workflow from a terminal.
 *
 *   trb spec ls                         features in this project, their state and task progress
 *   trb spec new "<name>" [-d "<what>"] allocate specs/NNN-name/ with a spec.md skeleton
 *   trb spec constitution [init]        show it, or write the template (only when you say init)
 *   trb spec show <feature>             files and progress of one feature
 *   trb spec tasks <feature>            its task list, grouped by phase
 *   trb spec step <step> [feature]      run constitution|specify|clarify|plan|tasks|analyze in a session
 *   trb spec attach <session> <feature|path> [--inline]
 *   trb spec implement <feature>        a goal-mode session that works until every task is ticked
 *   trb spec architecture [feature]     a read-only design discussion that ends in spec-file changes you approve
 *
 * Features are named by id (001-add-export), number (1) or name. The project is the current directory.
 */
import path from "path";
import { opts } from "../args";
import { api, resolveSessionId } from "../client";
import { c, die, printJson, printLine, table } from "../fmt";
import { watch } from "./session";

interface Feature {
  id: string;
  dir: string;
  title: string;
  status: string;
  tasks: { done: number; total: number };
  files: { spec: boolean; plan: boolean; tasks: boolean; research: boolean; dataModel: boolean; quickstart: boolean; contracts: string[] };
}
interface Overview {
  constitution: { exists: boolean; path: string; placeholders: boolean };
  features: Feature[];
  numbering: string;
  specify: { path: string | null };
}
interface Task {
  line: number;
  id: string | null;
  done: boolean;
  parallel: boolean;
  story: string | null;
  text: string;
  phase: string | null;
}

async function workspaceRoot(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

const STATUS_COLOR: Record<string, (s: string) => string> = { draft: c.dim, planned: c.cyan, tasked: c.cyan, "in-progress": c.yellow, done: c.green };
const bar = (done: number, total: number, width = 10): string => {
  if (!total) return c.dim("·".repeat(width));
  const n = Math.round((done / total) * width);
  return c.green("█".repeat(n)) + c.dim("░".repeat(width - n));
};

const USAGE = `Usage: trb spec <ls|new|constitution|show|tasks|step|attach|implement|architecture> …
  trb spec ls
  trb spec new "<name>" [--description "<what it should do>"]
  trb spec constitution [init]
  trb spec show <feature>
  trb spec tasks <feature>
  trb spec step <constitution|specify|clarify|plan|tasks|analyze> [feature] [-i "<note>"] [-e engine] [-m model] [-a agent] [-d]
  trb spec attach <session> <feature|path> [--inline]
  trb spec implement <feature> [--parallel] [--pair p] [--test "<cmd>"] [--max-turns n] [-e engine] [-m model] [-d]
  trb spec architecture [feature] [-t "<topic>"] [-e engine] [-m model] [-d]`;

export async function cmdSpec(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    description: { type: "string" },
    input: { type: "string", short: "i" },
    topic: { type: "string", short: "t" },
    engine: { type: "string", short: "e" },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    agent: { type: "string", short: "a" },
    pair: { type: "string", short: "p" },
    session: { type: "string", short: "s" },
    test: { type: "string" },
    "max-turns": { type: "string" },
    "max-minutes": { type: "string" },
    parallel: { type: "boolean" },
    inline: { type: "boolean" },
    detach: { type: "boolean", short: "d" },
    json: { type: "boolean" },
  });
  const sub = positionals[0];
  if (!sub) die(USAGE);
  const root = await workspaceRoot();
  const run = {
    engine: values.engine,
    model: values.model,
    effort: values.effort,
    agent: values.agent,
    pairId: values.pair,
    sessionId: values.session ? await resolveSessionId(values.session) : undefined,
  };
  const follow = async (id: string): Promise<number> => (values.detach ? printLine(id) : watch(id, { tree: true, json: false, interruptOnSigint: true }));

  switch (sub) {
    case "ls":
    case "list": {
      const { specs } = await api<{ specs: Overview }>("GET", `/api/specs/${root}`);
      if (values.json) return printJson(specs);
      console.log(`${c.bold("constitution")}  ${specs.constitution.exists ? `${specs.constitution.path}${specs.constitution.placeholders ? c.yellow("  (still has [PLACEHOLDER]s)") : ""}` : c.dim("none (trb spec constitution init)")}`);
      if (!specs.features.length) {
        console.log(c.dim('no features yet: trb spec new "<name>"'));
        return 0;
      }
      console.log(table(specs.features.map((f) => [f.id, (STATUS_COLOR[f.status] ?? c.dim)(f.status), `${bar(f.tasks.done, f.tasks.total)} ${f.tasks.total ? `${f.tasks.done}/${f.tasks.total}` : ""}`, f.title]), ["feature", "status", "tasks", "title"]));
      return 0;
    }

    case "new": {
      const name = positionals.slice(1).join(" ").trim();
      if (!name) die('Usage: trb spec new "<name>" [--description "<what it should do>"]');
      const r = await api<{ feature: Feature }>("POST", `/api/specs/${root}/features`, { name, description: values.description });
      if (values.json) return printJson(r);
      console.log(`created ${c.bold(r.feature.dir)}/spec.md`);
      console.error(c.dim(`next: trb spec step specify ${r.feature.id}`));
      return 0;
    }

    case "constitution": {
      if (positionals[1] === "init") {
        const r = await api<{ path: string }>("POST", `/api/specs/${root}/constitution`, {});
        console.log(`wrote ${r.path}`);
        console.error(c.dim("next: trb spec step constitution   (an agent fills it in from the repository)"));
        return 0;
      }
      const { specs } = await api<{ specs: Overview }>("GET", `/api/specs/${root}`);
      if (!specs.constitution.exists) die("No constitution yet. Write the template with `trb spec constitution init`.");
      const f = await api<{ content: string }>("GET", `/api/specs/${root}/file?path=${encodeURIComponent(specs.constitution.path)}`);
      return printLine(f.content);
    }

    case "show": {
      if (!positionals[1]) die("Usage: trb spec show <feature>");
      const r = await api<{ feature: Feature }>("GET", `/api/specs/${root}/features/${encodeURIComponent(positionals[1])}`);
      if (values.json) return printJson(r);
      const f = r.feature;
      console.log(`${c.bold(f.id)}  ${STATUS_COLOR[f.status]?.(f.status) ?? f.status}  ${f.title}`);
      const have = (ok: boolean, name: string) => (ok ? c.green(name) : c.dim(name));
      console.log(`  ${have(f.files.spec, "spec")}  ${have(f.files.plan, "plan")}  ${have(f.files.tasks, "tasks")}  ${have(f.files.research, "research")}  ${have(f.files.dataModel, "data-model")}  ${have(f.files.quickstart, "quickstart")}  ${have(f.files.contracts.length > 0, `contracts(${f.files.contracts.length})`)}`);
      console.log(`  tasks ${bar(f.tasks.done, f.tasks.total)} ${f.tasks.done}/${f.tasks.total}`);
      return 0;
    }

    case "tasks": {
      if (!positionals[1]) die("Usage: trb spec tasks <feature>");
      const r = await api<{ feature: Feature; tasks: { tasks: Task[]; total: number; done: number } | null }>("GET", `/api/specs/${root}/features/${encodeURIComponent(positionals[1])}`);
      if (values.json) return printJson(r);
      if (!r.tasks) die(`${r.feature.id} has no tasks.md yet: trb spec step tasks ${r.feature.id}`);
      let phase: string | null | undefined;
      for (const t of r.tasks.tasks) {
        if (t.phase !== phase) {
          phase = t.phase;
          console.log(`\n${c.bold(phase ?? "Tasks")}`);
        }
        console.log(`  ${t.done ? c.green("[x]") : "[ ]"} ${t.id ?? c.dim(`l${t.line + 1}`)}${t.parallel ? c.cyan(" [P]") : ""}${t.story ? c.yellow(` [${t.story}]`) : ""} ${t.done ? c.dim(t.text) : t.text}`);
      }
      console.log(`\n${bar(r.tasks.done, r.tasks.total)} ${r.tasks.done}/${r.tasks.total}`);
      return 0;
    }

    case "step": {
      const step = positionals[1];
      if (!step) die(USAGE);
      const r = await api<{ session: { id: string; title: string } }>("POST", `/api/specs/${root}/steps/${step}`, { ...run, feature: positionals[2], input: values.input });
      if (values.json) return printJson(r);
      console.error(c.dim(`${r.session.title} → ${r.session.id}`));
      return follow(r.session.id);
    }

    case "attach": {
      if (!positionals[1] || !positionals[2]) die("Usage: trb spec attach <session> <feature|path> [--inline]");
      const id = await resolveSessionId(positionals[1]);
      let target = positionals[2];
      if (!/^(specs|\.specify)\//.test(target)) {
        const f = await api<{ feature: Feature }>("GET", `/api/specs/${root}/features/${encodeURIComponent(target)}`);
        target = f.feature.dir;
      }
      const r = await api<{ attached: { spec_path: string; mode: string }; estimate: { tokens: number } }>("POST", `/api/sessions/${id}/specs`, { path: target, mode: values.inline ? "inline" : "ref" });
      if (values.json) return printJson(r);
      console.log(`attached ${r.attached.spec_path} (${r.attached.mode}) to ${id}: about ${r.estimate.tokens} tokens in total across its attachments`);
      return 0;
    }

    case "implement": {
      if (!positionals[1]) die(USAGE);
      const r = await api<{ mode: string; note: string | null; heads: Array<{ id: string; tasks: string[] }>; session: { id: string; title: string } }>("POST", `/api/specs/${root}/features/${encodeURIComponent(positionals[1])}/implement`, {
        ...run,
        parallel: values.parallel === true,
        test: values.test,
        max_turns: values["max-turns"] !== undefined ? Number(values["max-turns"]) : undefined,
        max_minutes: values["max-minutes"] !== undefined ? Number(values["max-minutes"]) : undefined,
      });
      if (values.json) return printJson(r);
      if (r.note) console.error(c.yellow(r.note));
      if (r.heads.length) console.error(c.dim(`heads: ${r.heads.map((h) => `${h.id} (${h.tasks.join(", ")})`).join("; ")}`));
      console.error(c.dim(`${r.session.title} → ${r.session.id}; \`trb goal ${r.session.id} stop\` ends it.`));
      return follow(r.session.id);
    }

    case "architecture": {
      const r = await api<{ session: { id: string; title: string }; tools: boolean }>("POST", `/api/specs/${root}/architecture`, { ...run, feature: positionals[1], topic: values.topic });
      if (values.json) return printJson(r);
      console.error(c.dim(`${r.session.title} → ${r.session.id}. Answer its questions with \`trb plan ${r.session.id} answer …\`, then \`trb plan ${r.session.id} approve\` to let it write the spec files.`));
      return follow(r.session.id);
    }

    default:
      die(`Unknown spec command "${sub}".\n${USAGE}`);
  }
}
