/**
 * `trb lab`: ask where a project could be better, from a terminal.
 *
 *   trb lab show [--status open|dismissed|shipped|all] [--lens L] [--json]
 *   trb lab run <lens> [scope] [--note "<focus>"] [-e engine] [-m model] [-a agent] [-d]
 *   trb lab sweep <lens> [module…] [--limit N] [--parallel N] [--plan] [--note …] [-e engine] [-m model]
 *   trb lab sweeps                                       sweeps and how far along they are
 *   trb lab cancel <sweep>                               stop starting new modules
 *   trb lab roadmap|spec|fix|design <finding>            hand a finding to another module
 *   trb lab dismiss|ship|reopen <finding>                change its status
 *   trb lab rm <finding>
 *
 * A scope is `project` (the default), `diff` (uncommitted changes) or a folder or file. The project is the current directory.
 */
import path from "path";
import { opts } from "../args";
import { api } from "../client";
import { c, die, printJson, printLine } from "../fmt";
import { watch } from "./session";

interface Finding {
  id: string;
  title: string;
  lens: string | null;
  scope: string | null;
  impact: string;
  effort: string;
  status: string;
  evidence: string[];
  missing: string[];
  drifted: string[];
  problem: string | null;
  unmeasured: boolean;
  roadmap: string | null;
  spec: string | null;
}
interface Sweep {
  id: string;
  lens: string;
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: boolean;
}
interface Plan {
  lens: string;
  modules: Array<{ path: string; files: number; tokens: number }>;
  tokens: number;
  skipped: string[];
}
interface Session {
  id: string;
  title: string;
}

const USAGE = `Usage: trb lab <show|run|sweep|sweeps|cancel|roadmap|spec|fix|design|dismiss|ship|reopen|rm> …
  trb lab show [--status open|dismissed|shipped|all] [--lens L]
  trb lab run <features|ui|ux|ai|perf|dx|review|security> [project|diff|<path>] [--note "<focus>"] [-e engine] [-m model] [--detach]
  trb lab sweep <lens> [module…] [--limit N] [--parallel N] [--plan]
  trb lab sweeps
  trb lab cancel <sweep>
  trb lab roadmap|spec|fix|design <finding>
  trb lab dismiss|ship|reopen|rm <finding>`;

const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const impact = (i: string): string => (i === "high" ? c.red(i) : i === "medium" ? c.yellow(i) : c.dim(i));

async function workspaceRoot(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

export async function cmdLab(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    status: { type: "string", short: "s" },
    lens: { type: "string", short: "l" },
    note: { type: "string", short: "n" },
    limit: { type: "string" },
    parallel: { type: "string" },
    plan: { type: "boolean" },
    engine: { type: "string", short: "e" },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    agent: { type: "string", short: "a" },
    pair: { type: "string", short: "p" },
    detach: { type: "boolean", short: "d" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "show";
  const root = await workspaceRoot();
  const base = `/api/lab/${root}`;
  const who = { engine: values.engine, model: values.model, effort: values.effort, agent: values.agent, pairId: values.pair };
  const need = (what: string): string => positionals[1] ?? die(`Usage: trb lab ${sub} <${what}>`);
  const follow = (s: Session) => {
    console.error(c.dim(`${s.title} → ${s.id}`));
    return values.detach ? printLine(s.id) : watch(s.id, { tree: true, json: false, interruptOnSigint: true });
  };

  switch (sub) {
    case "show":
    case "ls":
    case "list": {
      const { findings, sweeps } = await api<{ findings: Finding[]; sweeps: Sweep[] }>("GET", base);
      const want = values.status ?? "open";
      const shown = findings.filter((f) => (want === "all" ? true : want === "open" ? f.status === "new" || f.status === "accepted" : f.status === want) && (!values.lens || f.lens === values.lens));
      if (values.json) return printJson(shown);
      for (const s of sweeps.filter((x) => x.running || x.queued)) console.log(c.green(`● sweep ${s.id} (${s.lens}): ${s.done}/${s.total} done, ${s.running} running, ${s.queued} waiting`));
      if (!shown.length) {
        console.log(c.dim(findings.length ? "nothing matches: try --status all" : "no findings yet: trb lab run features"));
        return 0;
      }
      for (const f of shown) {
        const links = [f.roadmap && `roadmap ${f.roadmap}`, f.spec && f.spec].filter(Boolean).join(", ");
        console.log(`${c.bold(f.id)}  ${f.title}`);
        console.log(`  ${c.cyan(f.lens ?? "—")} · impact ${impact(f.impact)} · effort ${f.effort}${f.unmeasured ? c.yellow(" · unmeasured") : ""}${f.status !== "new" ? c.dim(` · ${f.status}`) : ""}${links ? c.dim(` · ${links}`) : ""}`);
        if (f.evidence.length) console.log(c.dim(`  ${f.evidence.slice(0, 2).join(", ")}${f.evidence.length > 2 ? ` +${f.evidence.length - 2}` : ""}`));
        if (f.missing.length) console.log(c.yellow(`  ! no longer exists: ${f.missing.join(", ")}`));
        if (f.drifted.length) console.log(c.yellow(`  ! changed since cited: ${f.drifted.join(", ")}`));
        if (f.problem) console.log(c.yellow(`  ! ${f.problem}`));
      }
      return 0;
    }

    case "run": {
      const lens = positionals[1];
      if (!lens) die("Usage: trb lab run <lens> [scope]");
      const r = await api<{ session: Session }>("POST", `${base}/run`, { lens, scope: positionals[2], note: values.note, ...who });
      if (values.json) return printJson(r);
      return follow(r.session);
    }

    case "sweep": {
      const lens = positionals[1];
      if (!lens) die("Usage: trb lab sweep <lens> [module…]");
      const scopes = positionals.slice(2);
      const limit = values.limit !== undefined ? Number(values.limit) : undefined;
      const q = new URLSearchParams({ lens, ...(scopes.length ? { scopes: scopes.join(",") } : {}), ...(limit ? { limit: String(limit) } : {}) });
      if (values.plan) {
        const { plan } = await api<{ plan: Plan }>("GET", `${base}/sweep?${q}`);
        if (values.json) return printJson(plan);
        for (const m of plan.modules) console.log(`${m.path.padEnd(40)} ${String(m.files).padStart(5)} files  ${tokens(m.tokens).padStart(6)} tokens`);
        console.log(c.dim(`about ${tokens(plan.tokens)} tokens to read in full (a ceiling)${plan.skipped.length ? `; ${plan.skipped.length} more module(s) left out` : ""}`));
        return 0;
      }
      const r = await api<{ sweepId: string; plan: Plan; sessions: Session[] }>("POST", `${base}/sweep`, { lens, scopes: scopes.length ? scopes : undefined, limit, parallel: values.parallel !== undefined ? Number(values.parallel) : undefined, note: values.note, ...who });
      if (values.json) return printJson(r);
      console.log(`sweep ${c.bold(r.sweepId)}: ${r.plan.modules.length} modules, ${r.sessions.length} started now, the rest as those finish`);
      console.log(c.dim("follow it with: trb lab sweeps"));
      return 0;
    }

    case "sweeps": {
      const { sweeps } = await api<{ sweeps: Sweep[] }>("GET", base);
      if (values.json) return printJson(sweeps);
      if (!sweeps.length) console.log(c.dim("no sweeps yet: trb lab sweep <lens>"));
      for (const s of sweeps) console.log(`${c.bold(s.id)}  ${s.lens}  ${s.done}/${s.total} done, ${s.running} running, ${s.queued} waiting${s.failed ? c.red(`, ${s.failed} could not start`) : ""}${s.cancelled ? c.dim("  (stopped)") : ""}`);
      return 0;
    }

    case "cancel": {
      const r = await api<{ sweep: Sweep }>("POST", `${base}/sweeps/${encodeURIComponent(need("sweep"))}/cancel`, {});
      if (values.json) return printJson(r);
      console.log(`stopped ${r.sweep.id}: ${r.sweep.running} still running, the rest will not start`);
      return 0;
    }

    case "roadmap": {
      const r = await api<{ finding: Finding; itemId: string }>("POST", `${base}/findings/${encodeURIComponent(need("finding"))}/roadmap`, {});
      if (values.json) return printJson(r);
      console.log(`${r.finding.id} is on the roadmap as ${c.bold(r.itemId)}`);
      return 0;
    }

    case "spec":
    case "fix":
    case "design": {
      const r = await api<{ session: Session }>("POST", `${base}/findings/${encodeURIComponent(need("finding"))}/${sub}`, who);
      if (values.json) return printJson(r);
      return follow(r.session);
    }

    case "dismiss":
    case "ship":
    case "reopen": {
      const status = sub === "dismiss" ? "dismissed" : sub === "ship" ? "shipped" : "new";
      const r = await api<{ finding: Finding }>("PATCH", `${base}/findings/${encodeURIComponent(need("finding"))}`, { status });
      if (values.json) return printJson(r);
      console.log(`${r.finding.id} ${r.finding.status}`);
      return 0;
    }

    case "rm":
    case "delete": {
      await api("DELETE", `${base}/findings/${encodeURIComponent(need("finding"))}`);
      console.log(`removed ${positionals[1]}`);
      return 0;
    }

    default:
      return die(USAGE);
  }
}
