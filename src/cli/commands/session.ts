/**
 * Session commands: the day-to-day surface. `trb run` opens a lead and follows it; everything else
 * inspects or steers sessions the daemon already holds.
 */
import path from "path";
import { opts } from "../args";
import { api, follow, resolveSessionId, type FollowEvent } from "../client";
import { c, die, money, printJson, printLine, statusColor, table, tokens } from "../fmt";

export type GoalView = { status: string; text: string; check_cmd: string | null; turns_used: number; max_turns: number; max_minutes: number; last_note: string | null; last_check_exit: number | null };

type View = {
  id: string;
  title: string;
  status: string;
  parent: string | null;
  depth: number;
  role: string | null;
  engine: string;
  model: string | null;
  effort: string | null;
  pair: string | null;
  agent?: string | null;
  skills?: string[] | null;
  /** Set while a running session is parked on a usage limit (ISO time it is sent again). */
  parked_until?: string | null;
  turns: number;
  isolation: string;
  cwd: string;
  branch: string | null;
  changes: { files: number; insertions: number; deletions: number } | null;
  merged: boolean;
  cost_usd: number | null;
  tokens: { input: number; output: number; cache_read: number };
  output?: string | null;
  error?: string | null;
  running_for_sec?: number;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** The text of a prompt: the positionals, or stdin when none are given (or "-"). */
async function promptFrom(positionals: string[], what = "a prompt"): Promise<string> {
  let text = positionals.join(" ").trim();
  if (!text || text === "-") {
    if (process.stdin.isTTY && !text) die(`Give ${what}, or pipe it in.`);
    text = (await readStdin()).trim();
  }
  if (!text) die(`${what[0].toUpperCase()}${what.slice(1)} is empty.`);
  return text;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function styleLine(text: string): string {
  if (/^\[stderr\]/.test(text)) return c.yellow(text);
  if (/^\[trb\]|^\[worktree\]/.test(text)) return c.dim(text);
  if (/^\[[a-z]+\]\s+(→|✓|✗|\(thinking)/.test(text)) return c.dim(text);
  if (/^\[[a-z]+\]\s+(done|failed|stopped|turn failed|error|rate limit|session started)/.test(text)) return c.dim(text);
  return text;
}

function renderLog(data: { session: string; text: string; label?: string; depth?: number }, watched: string, tree: boolean): void {
  const lines = String(data.text).split("\n");
  const child = tree && data.session !== watched;
  const prefix = child ? c.magenta(`${"  ".repeat(Math.max(1, data.depth ?? 1))}${data.label ?? data.session} │ `) : "";
  for (const line of lines) process.stdout.write(prefix + styleLine(line) + "\n");
}

/** A session parked on a usage limit reads "parked until 14:05" rather than "running". */
function statusText(s: Pick<View, "status" | "parked_until">): string {
  if (!s.parked_until) return s.status;
  return `parked until ${new Date(Date.parse(s.parked_until)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function oneLine(s: View): string {
  const model = s.model ? ` ${s.model}` : "";
  const bits = [
    statusColor(s.status)(statusText(s).padEnd(7)),
    `${s.role ? `${s.role} · ` : ""}${s.agent ? `${s.agent} · ` : ""}${s.engine}${model}${s.effort ? ` @${s.effort}` : ""}`,
    s.changes ? c.green(`+${s.changes.insertions}`) + "/" + c.red(`-${s.changes.deletions}`) + ` in ${s.changes.files} file${s.changes.files === 1 ? "" : "s"}${s.merged ? c.dim(" (merged)") : ""}` : "",
    s.cost_usd ? money(s.cost_usd) : "",
  ].filter(Boolean);
  return `${c.bold(s.id)}  ${bits.join(c.dim(" · "))}`;
}

function printFooter(root: View, children: View[]): void {
  const all = [root, ...children];
  const cost = all.reduce((sum, s) => sum + (s.cost_usd ?? 0), 0);
  const out = all.reduce((sum, s) => sum + s.tokens.output, 0);
  const inn = all.reduce((sum, s) => sum + s.tokens.input, 0);
  const mark = root.status === "failed" ? c.red("✗ failed") : c.green("✓ done");
  const kids = children.length ? ` · ${children.length} subagent${children.length === 1 ? "" : "s"}` : "";
  console.log(`\n${mark} ${c.dim("·")} ${c.bold(root.id)} ${c.dim(`· ${root.engine}${root.model ? ` ${root.model}` : ""}${kids} · ${tokens(inn)} in / ${tokens(out)} out${cost ? ` · ${money(cost)}` : ""}`)}`);
  if (root.status === "failed" && root.error) console.log(c.red(root.error.split("\n")[0]));
  console.log(c.dim(`  continue: trb send ${root.id} "…"    inspect: trb show ${root.id}`));
}

/* -------------------------------------------------------------------------- */
/* run / attach                                                               */
/* -------------------------------------------------------------------------- */

export async function watch(id: string, o: { tree: boolean; json: boolean; interruptOnSigint: boolean; since?: number; fromTurn?: boolean }): Promise<number> {
  const ac = new AbortController();
  let interrupted = false;
  const onSigint = async () => {
    if (o.interruptOnSigint && !interrupted) {
      interrupted = true;
      process.stderr.write(c.yellow("\ninterrupting… (the session keeps its context; `trb send` resumes it)\n"));
      await api("POST", `/api/sessions/${id}/goal/stop`).catch(() => {}); // a goal must not send the next turn
      await api("POST", `/api/sessions/${id}/interrupt`).catch(() => {});
    } else {
      ac.abort();
      process.stderr.write(c.dim(`\ndetached. ${id} keeps running; \`trb attach ${id}\` to follow, \`trb interrupt ${id}\` to stop.\n`));
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  await follow(id, {
    tree: o.tree,
    untilIdle: true,
    since: o.since,
    fromTurn: o.fromTurn,
    signal: ac.signal,
    onEvent: (e: FollowEvent) => {
      if (o.json) return;
      if (e.event === "log") renderLog(e.data, id, o.tree);
    },
  });
  // A goal keeps the session working past one turn: follow each turn until the goal is over.
  for (;;) {
    const g = (await api<{ goal: GoalView | null }>("GET", `/api/sessions/${id}/goal`).catch(() => ({ goal: null }))).goal;
    if (!g || g.status !== "active") {
      if (g && !o.json) console.error(c.dim(`goal ${g.status}: ${g.last_note ?? ""} (${g.turns_used}/${g.max_turns} turns)`));
      break;
    }
    await new Promise((r) => setTimeout(r, 700));
    const now = (await api<{ session: View }>("GET", `/api/sessions/${id}`)).session;
    if (now.status === "running") {
      await follow(id, { tree: o.tree, untilIdle: true, fromTurn: true, signal: ac.signal, onEvent: (e: FollowEvent) => (o.json ? undefined : e.event === "log" ? renderLog(e.data, id, o.tree) : undefined) });
    }
  }
  process.off("SIGINT", onSigint);

  const detail = await api<{ session: View; children: View[] }>("GET", `/api/sessions/${id}`);
  if (o.json) {
    console.log(JSON.stringify({ session: detail.session, children: detail.children }, null, 2));
  } else {
    printFooter(detail.session, detail.children);
  }
  if (interrupted) return 130;
  return detail.session.status === "failed" ? 1 : 0;
}

export async function cmdRun(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    engine: { type: "string", short: "e" },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    pair: { type: "string", short: "p" },
    agent: { type: "string", short: "a" },
    skills: { type: "string" },
    cwd: { type: "string", short: "C" },
    title: { type: "string", short: "t" },
    worktree: { type: "boolean", short: "w" },
    "no-subagents": { type: "boolean" },
    detach: { type: "boolean", short: "d" },
    json: { type: "boolean" },
    plan: { type: "boolean" },
    ask: { type: "boolean" },
    goal: { type: "string", short: "g" },
    check: { type: "string" },
    "max-turns": { type: "string" },
    "max-minutes": { type: "string" },
  });
  if (values.ask && values.plan) die("--ask and --plan are different modes: pick one.");
  if (values.ask && values.goal) die("A goal needs a session that can edit: drop --ask.");
  if ((values.check || values["max-turns"] || values["max-minutes"]) && !values.goal) die('--check, --max-turns and --max-minutes belong to a goal: add --goal "<what done looks like>".');
  const prompt = await promptFrom(positionals);
  const cwd = path.resolve(values.cwd ?? process.cwd());
  const { session } = await api<{ session: View }>("POST", "/api/sessions", {
    prompt,
    title: values.title,
    engine: values.engine,
    model: values.model,
    effort: values.effort,
    pair: values.pair,
    agent: values.agent,
    skills: values.skills !== undefined ? values.skills.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
    cwd,
    isolate: values.worktree === true,
    subagents: !values["no-subagents"],
    mode: values.plan ? "plan" : values.ask ? "ask" : undefined,
    goal: values.goal ? { text: values.goal, check: values.check, max_turns: values["max-turns"], max_minutes: values["max-minutes"] } : undefined,
  });
  if (values.detach) {
    if (values.json) console.log(JSON.stringify({ session }, null, 2));
    else console.log(session.id);
    return 0;
  }
  if (!values.json) {
    const pairNote = session.pair ? ` · pair ${session.pair}` : "";
    console.error(c.dim(`${session.id} · ${session.engine}${session.model ? ` ${session.model}` : ""}${pairNote} · ${cwd}`));
  }
  const code = await watch(session.id, { tree: true, json: values.json === true, interruptOnSigint: true });
  if (values.ask && !values.json) {
    const done = (await api<{ session: View }>("GET", `/api/sessions/${session.id}`)).session as View & { ask_cost_usd?: number | null };
    if (done.ask_cost_usd) console.error(c.dim(`${session.id} · ask cost ${money(done.ask_cost_usd)}`));
  }
  return code;
}

/** `trb ask "<question>"`: a read-only question on the engine's cheap model, answer printed, session kept for follow-ups. */
export async function cmdAsk(argv: string[]): Promise<number> {
  return cmdRun([...argv, "--ask", "--no-subagents"]);
}

export async function cmdAttach(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { replay: { type: "boolean" }, flat: { type: "boolean" } });
  if (!positionals[0]) die("Usage: trb attach <session>");
  const id = await resolveSessionId(positionals[0]);
  const session = (await api<{ session: View }>("GET", `/api/sessions/${id}`)).session;
  if (session.status !== "running" && !values.replay) {
    console.error(c.dim(`${id} is ${session.status}; showing the last turn. (\`trb logs ${id}\` for everything)`));
    return cmdLogs([id, "--last"]);
  }
  return watch(id, { tree: !values.flat, json: false, interruptOnSigint: false, fromTurn: !values.replay });
}

/* -------------------------------------------------------------------------- */
/* ls / show / tree / logs                                                    */
/* -------------------------------------------------------------------------- */

export async function cmdLs(argv: string[]): Promise<number> {
  const { values } = opts(argv, { all: { type: "boolean", short: "a" }, closed: { type: "boolean" }, json: { type: "boolean" }, limit: { type: "string", short: "n" } });
  const qs = new URLSearchParams();
  if (values.all) qs.set("all", "1");
  if (values.closed) qs.set("closed", "1");
  if (values.limit) qs.set("limit", values.limit);
  const { sessions } = await api<{ sessions: View[] }>("GET", `/api/sessions?${qs}`);
  if (values.json) {
    console.log(JSON.stringify({ sessions }, null, 2));
    return 0;
  }
  if (sessions.length === 0) {
    console.log(c.dim("No sessions. Start one with: trb run \"…\""));
    return 0;
  }
  console.log(
    table(
      sessions.map((s) => [
        c.bold(s.id),
        statusColor(s.status)(statusText(s)),
        `${s.depth > 0 ? "↳ " : ""}${s.role ? `${s.role} · ` : ""}${s.engine}${s.model ? ` ${s.model}` : ""}`,
        s.title.length > 48 ? s.title.slice(0, 47) + "…" : s.title,
        s.cost_usd ? money(s.cost_usd) : "",
      ]),
      ["ID", "STATUS", "ENGINE", "TITLE", "COST"],
    ),
  );
  return 0;
}

function printTree(root: View, children: View[]): void {
  console.log(oneLine(root) + "  " + c.dim(root.title));
  const byParent = new Map<string, View[]>();
  for (const k of children) byParent.set(k.parent ?? "", [...(byParent.get(k.parent ?? "") ?? []), k]);
  const walk = (parent: string, indent: string) => {
    const kids = byParent.get(parent) ?? [];
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      console.log(`${indent}${last ? "└─" : "├─"} ${oneLine(k)}  ${c.dim(k.title.length > 40 ? k.title.slice(0, 39) + "…" : k.title)}`);
      walk(k.id, indent + (last ? "   " : "│  "));
    });
  };
  walk(root.id, "");
}

export async function cmdShow(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { full: { type: "boolean" }, json: { type: "boolean" } });
  const id = await resolveSessionId(positionals[0] ?? "last");
  const d = await api<{ session: View; brief: string | null; children: View[] }>("GET", `/api/sessions/${id}`);
  if (values.json) return printJson(d);
  printTree(d.session, d.children);
  console.log(c.dim(`\n${d.session.cwd}${d.session.branch ? ` · branch ${d.session.branch}` : ""} · ${d.session.turns} turn${d.session.turns === 1 ? "" : "s"}`));
  const out = d.session.output;
  if (out) {
    console.log(c.bold("\nLast answer"));
    console.log(values.full || out.length < 4000 ? out : out.slice(0, 4000) + c.dim(`\n… ${out.length - 4000} more chars (--full)`));
  }
  if (d.session.error && d.session.status === "failed") console.log(c.red(`\n${d.session.error}`));
  return 0;
}

export async function cmdLogs(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { follow: { type: "boolean", short: "f" }, tree: { type: "boolean" }, last: { type: "boolean" }, json: { type: "boolean" } });
  const id = await resolveSessionId(positionals[0] ?? "last");
  if (values.follow) return watch(id, { tree: values.tree === true, json: false, interruptOnSigint: false, fromTurn: true });
  const { lines } = await api<{ lines: Array<{ id: number; turn_id: string | null; session: string; text: string }> }>("GET", `/api/sessions/${id}/logs?${values.tree ? "tree=1&" : ""}limit=20000`);
  let shown = lines;
  if (values.last && lines.length) {
    const lastTurn = [...lines].reverse().find((l) => l.session === id)?.turn_id;
    shown = lines.filter((l) => l.turn_id === lastTurn || l.session !== id);
  }
  if (values.json) return printJson(shown);
  for (const l of shown) renderLog({ session: l.session, text: l.text, label: l.session === id ? undefined : l.session, depth: 1 }, id, values.tree === true);
  return 0;
}

/* -------------------------------------------------------------------------- */
/* send / spawn / interrupt / close / merge / diff                            */
/* -------------------------------------------------------------------------- */

export async function cmdSend(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { detach: { type: "boolean", short: "d" }, json: { type: "boolean" }, mode: { type: "string" } });
  if (!positionals[0]) die('Usage: trb send <session> "message" [--mode build|plan|ask]');
  if (values.mode && values.mode !== "plan" && values.mode !== "build" && values.mode !== "ask") die('--mode is "build", "plan" or "ask".');
  const id = await resolveSessionId(positionals[0]);
  const message = await promptFrom(positionals.slice(1), "a message");
  const sent = await api<{ cursor: number }>("POST", `/api/sessions/${id}/send`, { message, mode: values.mode });
  if (values.detach) return printLine(id);
  return watch(id, { tree: true, json: values.json === true, interruptOnSigint: true, since: sent.cursor });
}

export async function cmdSpawn(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    role: { type: "string", short: "r" },
    agent: { type: "string", short: "a" },
    engine: { type: "string", short: "e" },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    title: { type: "string", short: "t" },
    "no-isolate": { type: "boolean" },
    detach: { type: "boolean", short: "d" },
    json: { type: "boolean" },
  });
  if (!positionals[0]) die('Usage: trb spawn <parent-session> "brief" [--role scout] [-e engine]');
  const parent = await resolveSessionId(positionals[0]);
  const brief = await promptFrom(positionals.slice(1), "a brief");
  const { session } = await api<{ session: View }>("POST", `/api/sessions/${parent}/spawn`, {
    brief,
    title: values.title,
    role: values.role,
    agent: values.agent,
    engine: values.engine,
    model: values.model,
    effort: values.effort,
    isolate: values["no-isolate"] ? false : "auto",
  });
  if (values.detach) return printLine(session.id);
  console.error(c.dim(`${session.id} · ${session.role ?? session.engine} · ${session.isolation === "worktree" ? `worktree ${session.branch}` : "shared workspace"}`));
  return watch(session.id, { tree: true, json: values.json === true, interruptOnSigint: true });
}

export async function cmdInterrupt(argv: string[]): Promise<number> {
  const id = await resolveSessionId(argv[0] ?? die("Usage: trb interrupt <session>"));
  const { session } = await api<{ session: View }>("POST", `/api/sessions/${id}/interrupt`);
  console.log(`${session.id} ${session.status}`);
  return 0;
}

export async function cmdClose(argv: string[]): Promise<number> {
  const id = await resolveSessionId(argv[0] ?? die("Usage: trb close <session>"));
  const { session } = await api<{ session: View }>("POST", `/api/sessions/${id}/close`);
  console.log(`closed ${session.id}${session.branch ? c.dim(` (branch ${session.branch} kept: it has unmerged changes)`) : ""}`);
  return 0;
}

export async function cmdMerge(argv: string[]): Promise<number> {
  const id = await resolveSessionId(argv[0] ?? die("Usage: trb merge <session>"));
  const r = await api<{ merged: boolean; message: string; files: string[] }>("POST", `/api/sessions/${id}/merge`);
  console.log(r.merged ? c.green(r.message) : c.yellow(r.message));
  for (const f of r.files) console.log(c.dim(`  ${f}`));
  return r.merged ? 0 : 1;
}

export async function cmdDiff(argv: string[]): Promise<number> {
  const id = await resolveSessionId(argv[0] ?? die("Usage: trb diff <session>"));
  const r = await api<{ diff: string; truncated: boolean; note?: string }>("GET", `/api/sessions/${id}/diff`);
  if (r.note) console.error(c.dim(r.note));
  else if (!r.diff) console.error(c.dim("No committed changes."));
  process.stdout.write(r.diff);
  if (r.truncated) console.error(c.yellow("\n… diff truncated."));
  return 0;
}

