/**
 * `trb pr`: pull requests of a session, through the GitHub CLI (gh) of the operator.
 *
 *   trb pr create <session> [--base B] [--draft]     push the session's branch and open its PR
 *   trb pr ls [--state open|closed|merged|all]       the PRs of this folder's workspace
 *   trb pr checks <n>                                the PR's checks, and the state they roll up to
 *   trb pr merge <n> [--method squash|merge|rebase] [--delete-branch]
 *
 * The workspace is the current directory. <session> may be a unique id prefix, or "last".
 */
import { opts } from "../args";
import { api, resolveSessionId } from "../client";
import { c, die, printJson, printLine, table } from "../fmt";

const USAGE = `Usage: trb pr <create|ls|checks|merge> …
  trb pr create <session> [--base B] [--draft]
  trb pr ls [--state open|closed|merged|all]
  trb pr checks <n>
  trb pr merge <n> [--method squash|merge|rebase] [--delete-branch]`;

interface SessionPr {
  workspaceId: string;
  number: number;
  url: string;
  state: string;
  checksState: string;
}

const paint = (state: string): string => (state === "passing" ? c.green(state) : state === "failing" ? c.red(state) : state === "pending" ? c.yellow(state) : c.dim(state));

async function workspaceRoot(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: dir });
  return r.workspace.id;
}

export async function cmdPr(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    base: { type: "string" },
    draft: { type: "boolean" },
    state: { type: "string" },
    method: { type: "string" },
    "delete-branch": { type: "boolean" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "ls";
  const ws = await workspaceRoot();

  const numberOf = (raw: string | undefined): number => {
    const n = Number((raw ?? "").replace(/^#/, ""));
    if (!Number.isInteger(n) || n < 1) die(USAGE);
    return n;
  };

  switch (sub) {
    case "create": {
      const ref = positionals[1];
      if (!ref) die(USAGE);
      const sessionId = await resolveSessionId(ref);
      const r = await api<{ pr: SessionPr; created: boolean }>("POST", `/api/sessions/${sessionId}/pr`, { base: values.base, draft: values.draft === true });
      if (values.json) return printJson(r);
      console.log(`${r.created ? "opened" : "already open:"} ${c.bold(`#${r.pr.number}`)} ${r.pr.url}`);
      return 0;
    }

    case "ls":
    case "list": {
      const state = values.state ?? "open";
      const r = await api<{ prs: Array<{ number: number; title: string; state: string; draft: boolean; head: string; sessionId: string | null; checksState: string | null }> }>("GET", `/api/prs?workspace=${encodeURIComponent(ws)}&state=${encodeURIComponent(state)}`);
      if (values.json) return printJson(r);
      if (!r.prs.length) {
        console.log(c.dim(`no ${state} pull requests`));
        return 0;
      }
      console.log(
        table(
          r.prs.map((p) => [`#${p.number}`, p.state + (p.draft ? " (draft)" : ""), p.checksState ? paint(p.checksState) : c.dim("·"), p.head, p.sessionId ?? c.dim("·"), p.title]),
          ["PR", "STATE", "CHECKS", "BRANCH", "SESSION", "TITLE"],
        ),
      );
      return 0;
    }

    case "checks": {
      const n = numberOf(positionals[1]);
      const r = await api<{ pr: SessionPr; checks: Array<{ name: string; bucket: string; state: string; link: string | null }> }>("GET", `/api/prs/${encodeURIComponent(ws)}/${n}/checks`);
      if (values.json) return printJson(r);
      console.log(`PR #${n}: ${paint(r.pr.checksState)}`);
      if (!r.checks.length) console.log(c.dim("no checks reported"));
      for (const k of r.checks) console.log(`  ${k.bucket === "pass" ? c.green("✓") : k.bucket === "fail" || k.bucket === "cancel" ? c.red("✗") : c.yellow("●")} ${k.name} ${c.dim(k.state)}`);
      return 0;
    }

    case "merge": {
      const n = numberOf(positionals[1]);
      const r = await api<{ pr: SessionPr }>("POST", `/api/prs/${encodeURIComponent(ws)}/${n}/merge`, { method: values.method ?? "squash", deleteBranch: values["delete-branch"] === true });
      if (values.json) return printJson(r);
      printLine(`merged ${c.bold(`#${n}`)} (${r.pr.state})`);
      return 0;
    }

    default:
      return die(USAGE);
  }
}
