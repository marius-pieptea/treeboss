/**
 * `trb ci`: the CI workflow of this folder (.github/workflows/ci.yml), generated from what the project has.
 *
 *   trb ci init                 show the workflow that would be written, and what it was built from
 *   trb ci init --write         write it (never over an existing file)
 *   trb ci init --write --overwrite   replace an existing file
 *
 * The workspace is the current directory. --json prints the plan or the write result.
 */
import { opts } from "../args";
import { api } from "../client";
import { c, die, printJson } from "../fmt";
import { WORKFLOW_PATH, type WorkflowPlan } from "../../ci/workflow";

const USAGE = `Usage: trb ci init [--write] [--overwrite] [--json]
  trb ci init                  show the workflow for this folder (${WORKFLOW_PATH})
  trb ci init --write          write it; an existing file is kept unless --overwrite is given`;

async function workspaceRoot(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: dir });
  return r.workspace.id;
}

export async function cmdCi(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    write: { type: "boolean" },
    overwrite: { type: "boolean" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "init";
  if (sub !== "init") die(USAGE);
  const ws = await workspaceRoot();
  const r = await api<{ plan: WorkflowPlan; written?: boolean; path?: string }>("POST", `/api/ci/${encodeURIComponent(ws)}/workflow`, { write: values.write === true, overwrite: values.overwrite === true });
  if (values.json) return printJson(r);

  const { plan } = r;
  const i = plan.inputs;
  const found = [i.packageManager ? `${i.packageManager} (${i.lockfile ?? "no lockfile"})` : null, i.cargo ? "cargo" : null, i.go ? "go" : null, i.python ? "python" : null, i.playwright ? `playwright (${i.playwright})` : null].filter(Boolean);
  console.error(`${c.bold(plan.path)}  ${found.join(", ") || c.dim("no toolchain found")}`);
  console.error(`commands: ${i.verify.map((v) => `${v.name} ${c.dim(v.cmd)}`).join(", ") || c.dim("none")}`);
  if (r.written) {
    console.error(c.green(`wrote ${r.path}`));
    return 0;
  }
  if (plan.exists) console.error(c.yellow(`${plan.path} already exists: run with --write --overwrite to replace it`));
  else console.error(c.dim("not written. Add --write to create it."));
  console.log(plan.yaml);
  return 0;
}
