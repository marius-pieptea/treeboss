/**
 * `trb signals`: what the product reports back (Sentry errors, PostHog metrics, widget feedback), from a terminal.
 *
 *   trb signals ls [--source S] [--status St] [--json]    signals, most important first; metric numbers
 *   trb signals sync                                       pull every configured source now
 *   trb signals triage <id> <to_finding|to_roadmap|to_session|ignore> [--lane L] [-e engine] [-m model] [-a agent]
 *   trb signals token [--rotate]                           the feedback token the widget posts with
 *   trb signals widget [--origin URL] [--label L]          the HTML snippet for your site
 *
 * The project is the current directory. Signal ids are shown by `ls`.
 */
import path from "path";
import { opts } from "../args";
import { api } from "../client";
import { c, die, printJson, printLine, table } from "../fmt";

interface Signal {
  id: string;
  source: string;
  kind: string;
  title: string;
  severity: string;
  count: number;
  status: string;
  url: string | null;
  linkedRef: string | null;
}
interface Metric {
  id: string;
  title: string;
  meta: { value?: number };
}
interface Listing {
  signals: Signal[];
  metrics: Metric[];
  sources: { sentry: boolean; posthog: boolean };
  feedback: boolean;
}

const USAGE = `Usage: trb signals <ls|sync|triage|token|widget> …
  trb signals ls [--source sentry|posthog|feedback|manual] [--status new|triaged|linked|ignored] [--json]
  trb signals sync
  trb signals triage <id> <to_finding|to_roadmap|to_session|ignore> [--lane L] [-e engine] [-m model] [-a agent] [--session S]
  trb signals token [--rotate]
  trb signals widget [--origin https://your-daemon] [--label "Feedback"]`;

const SEVERITY_TONE: Record<string, (s: string) => string> = { critical: c.red, high: c.red, medium: c.yellow, low: c.dim };

async function workspaceRoot(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

export async function cmdSignals(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    source: { type: "string" },
    status: { type: "string" },
    lane: { type: "string", short: "l" },
    engine: { type: "string", short: "e" },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    agent: { type: "string", short: "a" },
    pair: { type: "string", short: "p" },
    session: { type: "string" },
    rotate: { type: "boolean" },
    origin: { type: "string" },
    label: { type: "string" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "ls";
  const ws = await workspaceRoot();
  const q = `workspace=${encodeURIComponent(ws)}`;

  switch (sub) {
    case "ls":
    case "list":
    case "show": {
      const f = new URLSearchParams({ workspace: ws });
      if (values.source) f.set("source", values.source);
      if (values.status) f.set("status", values.status);
      const data = await api<Listing>("GET", `/api/signals?${f.toString()}`);
      if (values.json) return printJson(data);
      if (!data.sources.sentry && !data.sources.posthog) console.log(c.dim("No error or metric source is set up for this project yet (SENTRY_* and POSTHOG_* settings)."));
      if (data.metrics.length) console.log(data.metrics.map((m) => `${c.bold(String(m.meta.value ?? 0))} ${c.dim(m.title)}`).join("   "));
      if (!data.signals.length) {
        console.log(c.dim("no signals yet: trb signals sync"));
        return 0;
      }
      const rows = data.signals.map((s) => [
        c.dim(s.id),
        (SEVERITY_TONE[s.severity] ?? c.dim)(s.severity),
        String(s.count),
        s.source,
        s.status === "new" ? c.bold(s.status) : s.status,
        s.title.length > 80 ? `${s.title.slice(0, 77)}...` : s.title,
      ]);
      console.log(table(rows, ["ID", "SEVERITY", "COUNT", "SOURCE", "STATUS", "TITLE"]));
      return 0;
    }
    case "sync": {
      const r = await api<{ sources: Array<{ source: string; configured: boolean; upserted: number; error: string | null }> }>("POST", `/api/signals/sync/${encodeURIComponent(ws)}`);
      if (values.json) return printJson(r);
      for (const s of r.sources) {
        if (!s.configured) console.log(`${c.dim("·")} ${s.source}: ${c.dim("not set up")}`);
        else if (s.error) console.log(`${c.red("✗")} ${s.source}: ${s.error}`);
        else console.log(`${c.green("✓")} ${s.source}: ${s.upserted} ${s.source === "posthog" ? "metric" : "issue"}${s.upserted === 1 ? "" : "s"}`);
      }
      return r.sources.some((s) => s.error) ? 1 : 0;
    }
    case "triage": {
      const [rawId, action] = positionals.slice(1);
      if (!rawId || !action) die(`Usage: trb signals triage <id> <to_finding|to_roadmap|to_session|ignore>`);
      const id = rawId.replace(/^\{?#?/, "").replace(/\}$/, "");
      const r = await api<{ signal: Signal; finding?: string; roadmapItem?: string; session?: string }>("POST", `/api/signals/${encodeURIComponent(id)}/triage`, {
        action,
        lane: values.lane,
        engine: values.engine,
        model: values.model,
        effort: values.effort,
        agent: values.agent,
        pairId: values.pair,
        sessionId: values.session,
      });
      if (values.json) return printJson(r);
      if (r.finding) console.log(`${c.green("✓")} finding ${r.finding}`);
      else if (r.roadmapItem) console.log(`${c.green("✓")} roadmap item ${r.roadmapItem}${values.lane ? "" : " in Next"}`);
      else if (r.session) console.log(`${c.green("✓")} session ${r.session} is working on it`);
      else console.log(`${c.dim("ignored")} ${r.signal.title}`);
      return 0;
    }
    case "token": {
      if (values.rotate) {
        const r = await api<{ token: string }>("POST", `/api/signals/token?${q}`, { rotate: true });
        if (values.json) return printJson(r);
        console.log(r.token);
        console.log(c.dim("The old token no longer works. Put the new one in your widget (trb signals widget)."));
        return 0;
      }
      const r = await api<{ token: string | null }>("GET", `/api/signals/token?${q}`);
      if (values.json) return printJson(r);
      if (!r.token) return printLine(c.dim("no feedback token yet: trb signals widget creates one"));
      return printLine(r.token);
    }
    case "widget": {
      const f = new URLSearchParams({ workspace: ws });
      if (values.origin) f.set("origin", values.origin);
      if (values.label) f.set("label", values.label);
      const r = await api<{ endpoint: string; html: string }>("GET", `/api/signals/widget?${f.toString()}`);
      if (values.json) return printJson(r);
      console.log(c.dim(`Posts to ${r.endpoint}. Paste this into the pages that should collect feedback:`));
      console.log(r.html);
      return 0;
    }
    default:
      die(`${USAGE}\n\nNo signals command "${sub}".`);
  }
}
