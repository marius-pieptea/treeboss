/**
 * `trb autopilot` and `trb schedule`: unattended runs over a spec's tasks, and cron-style jobs, from a terminal.
 *
 *   trb autopilot start <spec> [--budget N] [--max-tasks N] [-c N] [--approve-every N] [--approve-merge] [--approve-tagged] [--open-pr]
 *   trb autopilot ls | show <id> | pause <id> | resume <id> | stop <id> | approve <id> | reject <id>
 *   trb schedule ls
 *   trb schedule add "<name>" --cron "<m h dom mon dow>" --kind prompt|lab_sweep|verify|deps_update|signals_sync
 *                 [-p "<prompt>"] [--lens L] [-e engine] [--disabled]
 *   trb schedule rm <id> | run <id>
 *
 * The workspace is the current directory (registered on first use, as `trb roadmap` does). Runs and jobs are
 * named by their ids (ap_…, sc_…).
 */
import path from "path";
import { opts } from "../args";
import { api } from "../client";
import { c, die, money, printJson, printLine, ago } from "../fmt";

interface Run {
  id: string;
  spec_dir: string;
  status: string;
  budget_usd: number | null;
  spent_usd: number;
  max_tasks: number | null;
  concurrency: number;
  approval_policy: { merge: boolean; tagged: boolean; every: number | null };
  current_task: string | null;
  reason: string | null;
  done: number;
  gate: { key: string; kind: string; text: string } | null;
  log: Array<{ at: string; kind: string; text: string }>;
  updated_at: string;
}

interface Schedule {
  id: string;
  name: string;
  cron: string;
  kind: string;
  payload: Record<string, any>;
  engine: string | null;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: Record<string, any> | null;
}

const USAGE_AUTOPILOT = `Usage: trb autopilot <start|ls|show|pause|resume|stop|approve|reject> …
  trb autopilot start <spec> [--budget N] [--max-tasks N] [-c N] [--approve-every N] [--approve-merge] [--approve-tagged] [--open-pr]
  trb autopilot ls
  trb autopilot show <id>
  trb autopilot pause|resume|stop <id>
  trb autopilot approve|reject <id>`;

const USAGE_SCHEDULE = `Usage: trb schedule <ls|add|rm|run> …
  trb schedule ls
  trb schedule add "<name>" --cron "<minute hour day month weekday>" --kind <prompt|lab_sweep|verify|deps_update|signals_sync> [-p "<prompt>"] [--lens L] [-e engine] [--disabled]
  trb schedule rm <id>
  trb schedule run <id>`;

const STATUS_TEXT: Record<string, (s: string) => string> = {
  running: c.green,
  awaiting_approval: c.yellow,
  paused: c.yellow,
  done: c.green,
  failed: c.red,
  stopped: c.dim,
};

const idOf = (raw: string | undefined): string => (raw ?? "").trim();

async function workspaceId(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

function policyOf(v: Record<string, any>): { approval_policy: Record<string, unknown> } {
  const policy: Record<string, unknown> = {};
  if (v["approve-merge"]) policy.merge = true;
  if (v["approve-tagged"]) policy.tagged = true;
  if (v["approve-every"] !== undefined) policy.every = Number(v["approve-every"]);
  return { approval_policy: policy };
}

export async function cmdAutopilot(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    budget: { type: "string", short: "b" },
    "max-tasks": { type: "string" },
    concurrency: { type: "string", short: "c" },
    "approve-every": { type: "string" },
    "approve-merge": { type: "boolean" },
    "approve-tagged": { type: "boolean" },
    "open-pr": { type: "boolean" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "ls";
  const ws = await workspaceId();

  switch (sub) {
    case "start": {
      const spec = positionals[1];
      if (!spec) die(USAGE_AUTOPILOT);
      const body = {
        workspace: ws,
        spec,
        budget_usd: values.budget === undefined ? null : Number(values.budget),
        max_tasks: values["max-tasks"] === undefined ? null : Number(values["max-tasks"]),
        concurrency: values.concurrency === undefined ? null : Number(values.concurrency),
        open_pr: values["open-pr"] === true,
        ...policyOf(values),
      };
      const { run } = await api<{ run: Run }>("POST", "/api/autopilot", body);
      if (values.json) return printJson(run);
      console.log(`${c.bold(run.id)} ${c.dim(`autopilot on ${run.spec_dir}`)}`);
      console.log(c.dim(`budget ${run.budget_usd === null ? "none" : money(run.budget_usd)} · concurrency ${run.concurrency}`));
      return 0;
    }

    case "ls":
    case "list": {
      const { runs } = await api<{ runs: Run[] }>("GET", `/api/autopilot?workspace=${ws}`);
      if (values.json) return printJson(runs);
      if (!runs.length) return printLine(c.dim("no autopilot runs here: trb autopilot start <spec>"));
      for (const r of runs) {
        const st = (STATUS_TEXT[r.status] ?? ((s: string) => s))(r.status.replace("_", " "));
        const gate = r.gate ? c.yellow(`  ! ${r.gate.text}`) : "";
        console.log(`${c.dim(r.id)}  ${st.padEnd(20)} ${r.spec_dir}  ${r.done} done  ${money(r.spent_usd)}${r.budget_usd === null ? "" : ` / ${money(r.budget_usd)}`}  ${c.dim(ago(r.updated_at))}${gate}`);
      }
      return 0;
    }

    case "show": {
      const id = idOf(positionals[1]);
      if (!id) die(USAGE_AUTOPILOT);
      const { run } = await api<{ run: Run }>("GET", `/api/autopilot/${id}`);
      if (values.json) return printJson(run);
      console.log(`${c.bold(run.id)}  ${(STATUS_TEXT[run.status] ?? ((s: string) => s))(run.status.replace("_", " "))}  ${run.spec_dir}`);
      console.log(c.dim(`${run.done} done · ${money(run.spent_usd)} spent${run.budget_usd === null ? "" : ` of ${money(run.budget_usd)}`}${run.max_tasks ? ` · limit ${run.max_tasks} tasks` : ""}`));
      if (run.current_task) console.log(`running: ${run.current_task}`);
      if (run.gate) console.log(c.yellow(`waiting for approval: ${run.gate.text}\n  trb autopilot approve ${run.id}   or   trb autopilot reject ${run.id}`));
      else if (run.reason) console.log(c.dim(run.reason));
      console.log("");
      for (const l of run.log.slice(-40)) console.log(`${c.dim(new Date(l.at).toLocaleTimeString())}  ${l.kind === "error" ? c.red(l.text) : l.kind === "gate" ? c.yellow(l.text) : l.text}`);
      return 0;
    }

    case "pause":
    case "resume":
    case "stop":
    case "approve":
    case "reject": {
      const id = idOf(positionals[1]);
      if (!id) die(USAGE_AUTOPILOT);
      const { run } = await api<{ run: Run }>("POST", `/api/autopilot/${id}/${sub}`, {});
      if (values.json) return printJson(run);
      console.log(`${run.id}: ${run.status.replace("_", " ")}${run.reason ? ` — ${run.reason}` : ""}`);
      return 0;
    }

    default:
      die(USAGE_AUTOPILOT);
  }
}

export async function cmdSchedule(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    cron: { type: "string" },
    kind: { type: "string", short: "k" },
    prompt: { type: "string", short: "p" },
    lens: { type: "string", short: "l" },
    engine: { type: "string", short: "e" },
    disabled: { type: "boolean" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "ls";
  const ws = await workspaceId();

  switch (sub) {
    case "ls":
    case "list": {
      const { schedules } = await api<{ schedules: Schedule[] }>("GET", `/api/schedules?workspace=${ws}`);
      if (values.json) return printJson(schedules);
      if (!schedules.length) return printLine(c.dim("no scheduled jobs here: trb schedule add \"<name>\" --cron … --kind …"));
      for (const s of schedules) {
        const next = s.enabled && s.next_run_at ? c.dim(`next ${new Date(s.next_run_at).toLocaleString()}`) : c.dim("off");
        const last = s.last_result ? (s.last_result.ok ? c.green("last ok") : c.red("last failed")) : c.dim("never run");
        console.log(`${c.dim(s.id)}  ${s.name.padEnd(24)} ${s.cron.padEnd(14)} ${s.kind.padEnd(12)} ${next}  ${last}`);
      }
      return 0;
    }

    case "add": {
      const name = positionals.slice(1).join(" ").trim();
      if (!name || !values.cron || !values.kind) die(USAGE_SCHEDULE);
      const payload: Record<string, unknown> = {};
      if (values.prompt) payload.prompt = values.prompt;
      if (values.lens) payload.lens = values.lens;
      const { schedule } = await api<{ schedule: Schedule }>("POST", "/api/schedules", {
        workspace: ws,
        name,
        cron: values.cron,
        kind: values.kind,
        payload,
        engine: values.engine ?? null,
        enabled: !values.disabled,
      });
      if (values.json) return printJson(schedule);
      console.log(`${c.bold(schedule.id)} ${c.dim(`${schedule.name}: next ${schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : "never"}`)}`);
      return 0;
    }

    case "rm":
    case "remove": {
      const id = idOf(positionals[1]);
      if (!id) die(USAGE_SCHEDULE);
      const r = await api<{ removed: boolean }>("DELETE", `/api/schedules/${id}`);
      if (values.json) return printJson(r);
      console.log(r.removed ? `removed ${id}` : `no schedule ${id}`);
      return r.removed ? 0 : 1;
    }

    case "run": {
      const id = idOf(positionals[1]);
      if (!id) die(USAGE_SCHEDULE);
      const r = await api<{ run: { session_id: string | null; sweep_id: string | null; detail: string } }>("POST", `/api/schedules/${id}/run`, {});
      if (values.json) return printJson(r.run);
      console.log(r.run.detail);
      return 0;
    }

    default:
      die(USAGE_SCHEDULE);
  }
}
