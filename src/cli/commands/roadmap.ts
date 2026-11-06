/**
 * `trb roadmap`: the roadmap (ROADMAP.md) from a terminal.
 *
 *   trb roadmap show [--lane L] [--tag T] [--json]      lanes and items with spec progress
 *   trb roadmap init                                     write ROADMAP.md from the template (never replaces a file)
 *   trb roadmap add "<title>" [--lane L --tag T --target Q --spec S --docs D -d "<text>"]
 *   trb roadmap move <id> <lane> [--index N]
 *   trb roadmap done <id> [--undo]
 *   trb roadmap edit <id> [--title … --tag … --target … --spec … --docs … -d …]   ("" clears a field)
 *   trb roadmap rm <id>
 *   trb roadmap start <id> [spec|build] [-e engine] [-m model] [-a agent] [-d]
 *
 * Items are named by id ({#r12} in the file, written r12 here). The project is the current directory.
 */
import path from "path";
import { opts } from "../args";
import { api, resolveSessionId } from "../client";
import { c, die, printJson, printLine } from "../fmt";
import { watch } from "./session";

interface Item {
  key: string;
  id: string | null;
  title: string;
  done: boolean;
  tags: string[];
  target: string | null;
  spec: string | null;
  lane: string;
  status: string;
  progress: { done: number; total: number } | null;
  links: { spec: { ok: boolean; reason: string | null } | null; docs: { ok: boolean; reason: string | null } | null };
  sessions: Array<{ id: string; status: string }>;
}
interface State {
  exists: boolean;
  path: string;
  heading: string | null;
  lanes: Array<{ name: string; items: Item[]; progress: { items: number; shipped: number; tasksDone: number; tasksTotal: number } }>;
  broken: number;
}

const USAGE = `Usage: trb roadmap <show|init|add|move|done|edit|rm|start> …
  trb roadmap show [--lane L] [--tag T]
  trb roadmap init
  trb roadmap add "<title>" [--lane L] [--tag T] [--target 2026-Q4] [--spec specs/003-chat] [--docs path] [-D "<description>"]
  trb roadmap move <id> <lane> [--index N]
  trb roadmap done <id> [--undo]
  trb roadmap edit <id> [--title …] [--tag …] [--target …] [--spec …] [--docs …] [-D …]
  trb roadmap rm <id>
  trb roadmap start <id> [spec|build] [-e engine] [-m model] [-a agent] [--detach]`;

const bar = (done: number, total: number, width = 8): string => {
  if (!total) return c.dim("·".repeat(width));
  const n = Math.round((done / total) * width);
  return c.green("█".repeat(n)) + c.dim("░".repeat(width - n));
};

async function workspaceRoot(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

const idOf = (raw: string | undefined): string => (raw ?? "").replace(/^\{?#?/, "").replace(/\}$/, "");

export async function cmdRoadmap(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    lane: { type: "string", short: "l" },
    tag: { type: "string", short: "t" },
    target: { type: "string" },
    spec: { type: "string", short: "s" },
    docs: { type: "string" },
    title: { type: "string" },
    description: { type: "string", short: "D" },
    index: { type: "string" },
    undo: { type: "boolean" },
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
  const root = await workspaceRoot();
  const base = `/api/roadmap/${root}`;
  const need = async (): Promise<State> => {
    const { roadmap } = await api<{ roadmap: State }>("GET", base);
    if (!roadmap.exists) die(`There is no ${roadmap.path} here. Create it with: trb roadmap init`);
    return roadmap;
  };

  switch (sub) {
    case "show":
    case "ls":
    case "list": {
      const { roadmap } = await api<{ roadmap: State }>("GET", base);
      if (values.json) return printJson(roadmap);
      if (!roadmap.exists) {
        console.log(c.dim(`no ${roadmap.path} yet: trb roadmap init`));
        return 0;
      }
      console.log(`${c.bold(roadmap.heading ?? roadmap.path)}${roadmap.broken ? c.yellow(`   ${roadmap.broken} item${roadmap.broken === 1 ? "" : "s"} with a broken link`) : ""}`);
      for (const lane of roadmap.lanes) {
        if (values.lane && lane.name.toLowerCase() !== values.lane.toLowerCase()) continue;
        const items = lane.items.filter((i) => !values.tag || i.tags.includes(values.tag));
        console.log(`\n${c.bold(lane.name)} ${c.dim(`${lane.progress.shipped}/${lane.progress.items} shipped${lane.progress.tasksTotal ? `, ${lane.progress.tasksDone}/${lane.progress.tasksTotal} tasks` : ""}`)}`);
        if (!items.length) console.log(c.dim("  nothing here"));
        for (const i of items) {
          const mark = i.done ? c.green("[x]") : i.status === "in_progress" ? c.yellow("[~]") : "[ ]";
          const prog = i.progress ? ` ${bar(i.progress.done, i.progress.total)} ${i.progress.done}/${i.progress.total}` : "";
          const live = i.sessions.filter((s) => s.status === "running").length;
          const broken = [i.links.spec, i.links.docs].filter((l) => l && !l.ok).map((l) => l!.reason);
          console.log(`  ${mark} ${c.dim(i.id ?? "·")} ${i.done ? c.dim(i.title) : i.title}${i.tags.length ? c.cyan(` #${i.tags.join(" #")}`) : ""}${i.target ? c.dim(` @${i.target}`) : ""}${prog}${live ? c.green(` ● ${live} running`) : ""}${broken.length ? c.red(`  ! ${broken.join("; ")}`) : ""}`);
        }
      }
      return 0;
    }

    case "init": {
      const r = await api<{ roadmap: State }>("POST", `${base}/create`, {});
      if (values.json) return printJson(r);
      console.log(`wrote ${r.roadmap.path}`);
      return 0;
    }

    case "add": {
      const title = positionals.slice(1).join(" ").trim();
      if (!title) die('Usage: trb roadmap add "<title>" [--lane L] …');
      const state = await need();
      const r = await api<{ id: string; roadmap: State }>("POST", `${base}/items`, { lane: values.lane ?? state.lanes[0]?.name, title, description: values.description, tags: values.tag, target: values.target, spec: values.spec, docs: values.docs });
      if (values.json) return printJson(r);
      console.log(`added ${c.bold(r.id)}: ${title}`);
      return 0;
    }

    case "move": {
      const id = idOf(positionals[1]);
      const lane = positionals.slice(2).join(" ").trim() || values.lane;
      if (!id || !lane) die("Usage: trb roadmap move <id> <lane> [--index N]");
      const r = await api<{ roadmap: State }>("POST", `${base}/items/${encodeURIComponent(id)}/move`, { lane, index: values.index !== undefined ? Number(values.index) : undefined });
      if (values.json) return printJson(r);
      console.log(`moved ${id} to ${lane}`);
      return 0;
    }

    case "done": {
      const id = idOf(positionals[1]);
      if (!id) die("Usage: trb roadmap done <id> [--undo]");
      const r = await api<{ roadmap: State }>("PATCH", `${base}/items/${encodeURIComponent(id)}`, { done: !values.undo });
      if (values.json) return printJson(r);
      console.log(`${id} ${values.undo ? "reopened" : "shipped"}`);
      return 0;
    }

    case "edit": {
      const id = idOf(positionals[1]);
      if (!id) die("Usage: trb roadmap edit <id> [--title …] [--tag …] [--target …] [--spec …] [--docs …] [-D …]");
      const patch: Record<string, unknown> = {};
      if (values.title !== undefined) patch.title = values.title;
      if (values.description !== undefined) patch.description = values.description;
      if (values.tag !== undefined) patch.tags = values.tag;
      for (const k of ["target", "spec", "docs"] as const) if (values[k] !== undefined) patch[k] = values[k];
      if (!Object.keys(patch).length) die("Nothing to change: pass --title, --tag, --target, --spec, --docs or -D.");
      const r = await api<{ roadmap: State }>("PATCH", `${base}/items/${encodeURIComponent(id)}`, patch);
      if (values.json) return printJson(r);
      console.log(`updated ${id}`);
      return 0;
    }

    case "rm":
    case "delete": {
      const id = idOf(positionals[1]);
      if (!id) die("Usage: trb roadmap rm <id>");
      await api("DELETE", `${base}/items/${encodeURIComponent(id)}`);
      console.log(`removed ${id}`);
      return 0;
    }

    case "start": {
      const id = idOf(positionals[1]);
      if (!id) die(USAGE);
      const kind = positionals[2] === "build" ? "build" : "spec";
      const r = await api<{ session: { id: string; title: string } }>("POST", `${base}/items/${encodeURIComponent(id)}/start`, {
        kind,
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
