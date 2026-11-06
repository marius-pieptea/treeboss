/**
 * `trb release`: what a release covers, the agent-drafted notes, the publish, and the quick path. The project is the
 * current directory. The daemon does the work; this prints it.
 *
 *   trb release plan|cut <patch|minor|major>                  the quick path: a preview, or the bump, changelog, commit and tag (no agent)
 *   trb release range [--since tag|sha|date] [--prs]           what a release from that base would cover
 *   trb release draft [--since …] [--bump auto|patch|minor|major|prerelease] [--audience users|developers|both]
 *   trb release drafts                                         the drafts waiting to be published
 *   trb release publish <version> [--push] [--gh-release] [--deploy env] [--package dir]
 *   trb release publish-note <product> <note> [--push]           publish a product note (the file name under releases/products/, without .md)
 *   trb release undo <version> [--delete-remote-tag]             revert the release commit and remove the tag (local; the remote tag only with the flag)
 *   trb release ls                                             the published releases
 */
import path from "path";
import { opts } from "../args";
import { api } from "../client";
import { c, die, printJson } from "../fmt";

const USAGE = `Usage: trb release plan|cut <patch|minor|major>
       trb release range [--since tag|sha|date] [--prs] [--json]
       trb release draft [--since tag|sha|date] [--bump auto|patch|minor|major|prerelease] [--audience users|developers|both]
       trb release drafts [--json]
       trb release publish <version> [--push] [--gh-release] [--deploy env] [--package dir]
       trb release publish-note <product> <note> [--push]
       trb release undo <version> [--delete-remote-tag]
       trb release ls [--json]`;

interface Doc {
  version: string;
  file: string;
  status: string | null;
  meta: Record<string, string>;
  sessionId?: string | null;
}

async function workspaceId(): Promise<{ id: string; path: string }> {
  const dir = path.resolve(process.cwd());
  const r = await api<{ workspace: { id: string; path: string } }>("POST", "/api/workspaces", { path: dir });
  return { id: r.workspace.id, path: r.workspace.path };
}

const BUMPS = ["auto", "patch", "minor", "major", "prerelease"];
const AUDIENCES = ["users", "developers", "both"];

export async function cmdRelease(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    json: { type: "boolean" },
    since: { type: "string" },
    bump: { type: "string" },
    audience: { type: "string" },
    prs: { type: "boolean" },
    push: { type: "boolean" },
    "gh-release": { type: "boolean" },
    deploy: { type: "string" },
    package: { type: "string" },
    "delete-remote-tag": { type: "boolean" },
  });
  const [sub, arg, arg2] = positionals;

  if (sub === "plan" || sub === "cut") return quick(sub, arg, values);
  if (!sub || !["range", "draft", "drafts", "publish", "publish-note", "undo", "ls"].includes(sub)) die(USAGE);

  const ws = await workspaceId();
  const base = `/api/releases/${encodeURIComponent(ws.id)}`;

  if (sub === "range") {
    const q = new URLSearchParams({ base: values.since ?? "", prs: values.prs ? "1" : "0" });
    const { range } = await api<{ range: any }>("GET", `${base}/range?${q}`);
    if (values.json) return printJson(range);
    console.log(`${c.bold("Range")} from ${range.base.label}${range.base.sha ? c.dim(` (${range.base.sha.slice(0, 7)})`) : ""} to HEAD ${range.head.sha.slice(0, 7)}${range.head.branch ? ` on ${range.head.branch}` : ""}`);
    console.log(c.dim(`  ${range.commits.length} commit${range.commits.length === 1 ? "" : "s"}, ${range.diff.files} files, +${range.diff.insertions} -${range.diff.deletions}, ${range.roadmap.length} roadmap item${range.roadmap.length === 1 ? "" : "s"}, ${range.specs.length} spec${range.specs.length === 1 ? "" : "s"} with tasks done`));
    for (const w of range.warnings) console.log(c.yellow(`  ${w}`));
    for (const b of range.breaking) console.log(c.red(`  breaking: ${b}`));
    for (const x of range.commits.slice(0, 30)) console.log(`  ${c.dim(x.sha.slice(0, 7))} ${x.subject}`);
    if (range.commits.length > 30) console.log(c.dim(`  … ${range.commits.length - 30} more`));
    return 0;
  }

  if (sub === "draft") {
    if (values.bump && !BUMPS.includes(values.bump)) die(`--bump must be one of: ${BUMPS.join(", ")}.`);
    if (values.audience && !AUDIENCES.includes(values.audience)) die(`--audience must be one of: ${AUDIENCES.join(", ")}.`);
    const r = await api<{ sessionId: string; version: string | null; base: string; commits: number; suggested: { bump: string; reason: string } }>("POST", `${base}/draft`, {
      base: values.since ?? null,
      bump: values.bump ?? "auto",
      audience: values.audience ?? "users",
    });
    if (values.json) return printJson(r);
    console.log(`${c.bold("Drafting")} notes for ${r.commits} commit${r.commits === 1 ? "" : "s"} since ${r.base} in session ${r.sessionId}.`);
    console.log(c.dim(`  The draft lands in releases/drafts/ when the session finishes. See it with: trb release drafts`));
    if (!r.version) console.log(c.dim(`  The commits suggest ${r.suggested.bump}: ${r.suggested.reason}. The agent proposes the final bump.`));
    return 0;
  }

  if (sub === "drafts" || sub === "ls") {
    const r = await api<{ drafts: Doc[]; releases: Doc[] }>("GET", base);
    const docs = sub === "drafts" ? r.drafts : r.releases;
    if (values.json) return printJson(docs);
    if (!docs.length) console.log(c.dim(sub === "drafts" ? "No drafts. Draft one with: trb release draft" : "No published releases yet."));
    for (const d of docs) {
      const when = d.meta.date ?? "";
      const reason = d.meta.reason ? c.dim(`  ${d.meta.reason}`) : "";
      console.log(`${c.bold(d.version)}  ${c.dim(when)}  ${d.meta.bump ?? ""}  ${d.status === "draft" ? c.yellow("draft") : c.green(d.status ?? "")}${reason}`);
    }
    return 0;
  }

  if (sub === "undo") {
    if (!arg) die(USAGE);
    const r = await api<{ tag: string; revertCommit: string; tagRemoved: boolean; remoteTagDeleted: boolean; warnings: string[] }>("POST", `${base}/releases/${encodeURIComponent(arg)}/undo`, { deleteRemoteTag: !!values["delete-remote-tag"] });
    if (values.json) return printJson(r);
    console.log(`${c.green("Undid")} ${r.tag} in revert commit ${r.revertCommit.slice(0, 7)}${r.tagRemoved ? ", tag removed" : ""}${r.remoteTagDeleted ? ", remote tag deleted" : ""}.`);
    for (const w of r.warnings) console.log(c.yellow(`  ${w}`));
    return 0;
  }

  if (sub === "publish-note") {
    if (!arg || !arg2) die(USAGE);
    const r = await api<{ file: string; tag: string; commit: string; pushed: boolean; warnings: string[] }>("POST", `/api/releases/product/${encodeURIComponent(arg)}/notes/${encodeURIComponent(arg2)}/publish`, { push: !!values.push });
    if (values.json) return printJson(r);
    console.log(`${c.green("Published")} ${r.file} as ${r.tag} in commit ${r.commit.slice(0, 7)}${r.pushed ? ", pushed" : ""}.`);
    for (const w of r.warnings) console.log(c.yellow(`  ${w}`));
    return 0;
  }

  // publish
  if (!arg) die(USAGE);
  const r = await api<{ version: string; tag: string; commit: string; pushed: boolean; releaseUrl: string | null; deployId: string | null; warnings: string[] }>(
    "POST",
    `${base}/drafts/${encodeURIComponent(arg)}/publish`,
    { push: !!values.push, ghRelease: !!values["gh-release"], deploy: values.deploy ?? null, package: values.package ?? null },
  );
  if (values.json) return printJson(r);
  console.log(`${c.green("Published")} ${r.tag} in commit ${r.commit.slice(0, 7)}${r.pushed ? ", pushed" : ""}.`);
  if (r.releaseUrl) console.log(`  GitHub release: ${r.releaseUrl}`);
  if (r.deployId) console.log(`  Deploying ${values.deploy}: ${r.deployId}`);
  for (const w of r.warnings) console.log(c.yellow(`  ${w}`));
  if (!r.pushed && !values.push && !values["gh-release"]) console.log(c.dim(`  Nothing was pushed. Push with: git push origin HEAD && git push origin ${r.tag}`));
  return 0;
}

/** plan and cut: the mechanical release, no agent. The daemon runs it through the same range and version code. */
async function quick(sub: string, bump: string | undefined, values: { json?: boolean }): Promise<number> {
  if (!bump) die(USAGE);
  const ws = await workspaceId();
  const r = await api<{ plan: any; commit?: string; tag?: string }>("POST", `/api/release/${encodeURIComponent(ws.id)}`, { bump, mode: sub });
  if (values.json) return printJson(r);
  const p = r.plan;
  console.log(`${c.bold(sub === "cut" ? "Cut" : "Plan")}: ${p.current} → ${c.bold(p.version)}  ${c.dim(`tag ${p.tag}`)}${p.fromTag ? c.dim(`, since ${p.fromTag}`) : ""}`);
  for (const w of p.warnings) console.log(c.yellow(`  ${w}`));
  console.log(c.dim(`  ${p.commits.length} commit${p.commits.length === 1 ? "" : "s"}, ${p.roadmap.length} roadmap item${p.roadmap.length === 1 ? "" : "s"}`));
  if (sub === "plan") {
    console.log(`\n${p.changelog}`);
    console.log(c.dim("Nothing was written. Cut it with: trb release cut " + bump));
    return 0;
  }
  console.log(`\n${c.green("Released")} ${p.tag} in commit ${String(r.commit ?? "").slice(0, 7)}. Push the commit and the tag when you are ready.`);
  return 0;
}
