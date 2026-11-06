/**
 * `trb goal` and `trb plan`: the two modes that change how long, and how freely, a session works.
 */
import { opts } from "../args";
import { api, resolveSessionId } from "../client";
import { c, die, printJson } from "../fmt";
import type { GoalView } from "./session";

const describe = (g: GoalView): string =>
  `${g.status} · ${g.turns_used}/${g.max_turns} turns · ${g.check_cmd ? `check: ${g.check_cmd}${g.last_check_exit !== null ? ` (last exit ${g.last_check_exit})` : ""}` : "the agent reports DONE"}${g.last_note ? `\n${c.dim(g.last_note)}` : ""}\n${c.dim(g.text.split("\n")[0].slice(0, 160))}`;

export async function cmdGoal(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    check: { type: "string" },
    "max-turns": { type: "string" },
    "max-minutes": { type: "string" },
    "no-start": { type: "boolean" },
    json: { type: "boolean" },
  });
  if (!positionals[0]) die('Usage: trb goal <session> ["<goal>" [--check "<cmd>"] [--max-turns n] [--max-minutes n]]  |  trb goal <session> stop');
  const id = await resolveSessionId(positionals[0]);
  const text = positionals.slice(1).join(" ").trim();
  if (text === "stop") {
    const r = await api<{ goal: GoalView | null }>("POST", `/api/sessions/${id}/goal/stop`);
    if (values.json) return printJson(r), 0;
    console.log(r.goal ? describe(r.goal) : "no goal on this session.");
    return 0;
  }
  if (text) {
    const r = await api<{ goal: GoalView }>("PUT", `/api/sessions/${id}/goal`, {
      text,
      check: values.check,
      max_turns: values["max-turns"] !== undefined ? Number(values["max-turns"]) : undefined,
      max_minutes: values["max-minutes"] !== undefined ? Number(values["max-minutes"]) : undefined,
      start: !values["no-start"],
    });
    if (values.json) return printJson(r), 0;
    console.log(describe(r.goal));
    console.error(c.dim(`following: \`trb attach ${id}\`; \`trb goal ${id} stop\` ends it.`));
    return 0;
  }
  const r = await api<{ goal: GoalView | null }>("GET", `/api/sessions/${id}/goal`);
  if (values.json) return printJson(r), 0;
  console.log(r.goal ? describe(r.goal) : "no goal on this session.");
  return 0;
}

const PLAN_USAGE = "Usage: trb plan <session> [on|off|show|approve|answer <n|text>|skip|skip-plan|changes \"<note>\"|promote|depth quick|spec]";

interface QOption { label: string; description?: string; recommended?: boolean; reason?: string }
interface QState {
  mode: string;
  pending: { id: string; seq: number; question: string; options: QOption[]; allow_custom: boolean; multi: boolean } | null;
  depth?: string;
  plan: { id: string; version: number; title: string; summary: string; status: string; path?: string | null; depth?: string; feature?: string | null; promoted?: string | null; edited?: boolean; steps: Array<{ title: string; detail: string; files?: string[] }>; risks: string[] } | null;
  questions: Array<{ seq: number; question: string; status: string; answer: { choices: string[]; custom: string | null; skipped: boolean } | null }>;
}

function showPlanState(st: QState): void {
  for (const q of st.questions.filter((x) => x.status !== "pending")) {
    const a = q.answer;
    console.log(`${c.dim(`Q${q.seq}`)} ${q.question}\n   ${a?.skipped ? c.dim("skipped") : [...(a?.choices ?? []), a?.custom].filter(Boolean).join("; ") || c.dim(q.status)}`);
  }
  if (st.pending) {
    const q = st.pending;
    console.log(`\n${c.bold ? c.bold(`Q${q.seq}`) : `Q${q.seq}`} ${q.question}`);
    q.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.recommended ? " (recommended)" : ""}${o.description ? c.dim(` ${o.description}`) : ""}${o.recommended && o.reason ? c.dim(` Why: ${o.reason}`) : ""}`));
    console.log(c.dim(`answer: trb plan <session> answer <1-${q.options.length}${q.multi ? ", comma separated" : ""}${q.allow_custom ? " or your own text" : ""}> · trb plan <session> skip`));
  }
  if (st.plan) {
    const p = st.plan;
    console.log(`\n${p.title} (v${p.version}, ${p.status})${p.summary ? `\n${p.summary}` : ""}`);
    p.steps.forEach((x, i) => console.log(`${i + 1}. ${x.title}${x.detail ? `\n   ${x.detail}` : ""}${x.files?.length ? c.dim(`\n   ${x.files.join(", ")}`) : ""}`));
    if (p.risks.length) console.log(`Risks:\n${p.risks.map((r) => `- ${r}`).join("\n")}`);
    if (p.status === "draft") console.log(c.dim(`\napprove: trb plan <session> approve · adjust: trb plan <session> changes "<note>"`));
  }
  if (!st.pending && !st.plan && !st.questions.length) console.log(st.mode === "plan" ? "plan mode: no questions or plan yet." : "not in plan mode.");
}

export async function cmdPlan(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { json: { type: "boolean" } });
  if (!positionals[0]) die(PLAN_USAGE);
  const id = await resolveSessionId(positionals[0]);
  const action = positionals[1];
  if (!action) {
    const s = (await api<{ session: { mode: string } }>("GET", `/api/sessions/${id}`)).session;
    console.log(s.mode);
    return 0;
  }
  const state = () => api<QState>("GET", `/api/sessions/${id}/plan-state`);
  if (action === "show") {
    const st = await state();
    if (values.json) return printJson(st), 0;
    if (st.plan) {
      // The plan is a file: print where it is and what it says now (the operator may have edited it).
      const f = await api<{ path: string | null; text: string; from_file: boolean }>("GET", `/api/sessions/${id}/plan/file?plan=${st.plan.id}`);
      if (st.questions.length || st.pending) showPlanState({ ...st, plan: null });
      console.log(`\n${c.dim(`${f.path ?? "(no file: stored text)"} · v${st.plan.version} · ${st.plan.status}${st.plan.edited ? " · edited" : ""}${st.plan.promoted ? ` · promoted to ${st.plan.promoted}` : ""}`)}\n`);
      console.log(f.text);
      if (st.plan.status === "draft") console.log(c.dim(`\napprove: trb plan <session> approve · adjust: trb plan <session> changes "<note>" · skip: trb plan <session> skip-plan · spec: trb plan <session> promote`));
      return 0;
    }
    showPlanState(st);
    return 0;
  }
  if (action === "answer" || action === "skip") {
    const st = await state();
    const q = st.pending;
    if (!q) die("no question is waiting for an answer.");
    if (action === "skip") {
      await api("POST", `/api/sessions/${id}/plan/answer`, { question_id: q.id, skip: true });
      console.log(`Q${q.seq} skipped.`);
      return 0;
    }
    const raw = positionals.slice(2).join(" ").trim();
    if (!raw) die(PLAN_USAGE);
    // Numbers pick options (the recommended one with `r`), anything else is written text.
    const picks = raw.split(/[,\s]+/).filter(Boolean);
    const body: Record<string, unknown> = { question_id: q.id };
    if (picks.every((x) => /^\d+$/.test(x) || x === "r")) {
      body.choices = picks.map((x) => {
        const o = x === "r" ? q.options.find((v) => v.recommended) : q.options[Number(x) - 1];
        if (!o) die(`no option ${x}.`);
        return o.label;
      });
    } else body.custom = raw;
    await api("POST", `/api/sessions/${id}/plan/answer`, body);
    console.log(`Q${q.seq} answered.`);
    return 0;
  }
  if (action === "approve") {
    const st = await state();
    if (st.plan?.status === "draft") await api("POST", `/api/sessions/${id}/plan/plans/${st.plan.id}/approve`, {});
    else await api("POST", `/api/sessions/${id}/plan/approve`);
    console.log(`${id}: plan approved, building. \`trb attach ${id}\` to follow.`);
    return 0;
  }
  if (action === "skip-plan") {
    const st = await state();
    if (st.plan?.status !== "draft") die("there is no plan waiting for a decision.");
    await api("POST", `/api/sessions/${id}/plan/plans/${st.plan.id}/skip`, {});
    console.log(`${id}: plan skipped, plan mode off.`);
    return 0;
  }
  if (action === "promote") {
    const st = await state();
    if (!st.plan) die("there is no plan to promote.");
    const r = await api<{ feature: string; dir: string }>("POST", `/api/sessions/${id}/plan/plans/${st.plan.id}/promote`, {});
    console.log(`${id}: promoted to ${r.dir} (spec.md and plan.md written). Next: trb spec step ${r.feature} tasks`);
    return 0;
  }
  if (action === "depth") {
    const depth = positionals[2];
    if (depth !== "quick" && depth !== "spec") die(PLAN_USAGE);
    await api("PUT", `/api/sessions/${id}/plan/depth`, { depth });
    console.log(`${id}: the next plan becomes ${depth === "spec" ? "a spec feature" : "a file in plans/"}.`);
    return 0;
  }
  if (action === "changes") {
    const note = positionals.slice(2).join(" ").trim();
    const st = await state();
    if (!note) die(PLAN_USAGE);
    if (st.plan?.status !== "draft") die("there is no plan waiting for a decision.");
    await api("POST", `/api/sessions/${id}/plan/plans/${st.plan.id}/request-changes`, { note });
    console.log(`${id}: sent back with your note.`);
    return 0;
  }
  if (action !== "on" && action !== "off") die(PLAN_USAGE);
  await api("PUT", `/api/sessions/${id}/mode`, { mode: action === "on" ? "plan" : "build" });
  console.log(`${id}: ${action === "on" ? "plan mode on (read-only)" : "plan mode off"}`);
  return 0;
}
