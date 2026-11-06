/** Git API: /api/git/:root/… */
import { resolveRoot } from "../../workspaces";
import { materializedSkillPaths } from "../../skills/store";
import * as G from "../../git/ops";
import { HttpError, json, type RouteModule } from "../http";

const paths = (b: Record<string, any>): string[] => {
  if (!Array.isArray(b.paths)) throw new HttpError(400, "paths must be an array.");
  return b.paths.map(String);
};

export const gitRoutes: RouteModule = async (c) => {
  const m = c.match(/^\/api\/git\/([^/]+)\/([a-z-]+)(?:\/(.+))?$/);
  if (!m) return null;
  const root = resolveRoot(m[1]);
  const op = m[2];
  const sub = m[3];
  const cwd = root.dir;
  const get = c.method === "GET";
  const post = c.method === "POST";

  if (op === "info" && get) return json(await G.repoInfo(cwd));
  if (op === "init" && post) {
    await G.init(cwd);
    return json({ ok: true });
  }

  // The one write to the user's global git config: only on their explicit click (the sidebar's "Trust this folder").
  if (op === "trust" && post) return json({ ok: true, trusted: await G.trustFolder(cwd) });

  if (op === "status" && get) return json(await G.status(cwd, materializedSkillPaths()));

  if (op === "diff" && get) {
    return json(
      await G.diff(cwd, {
        path: c.q("path") ?? undefined,
        staged: c.q("staged") === "1",
        commit: c.q("commit") ?? undefined,
        base: c.q("base") ?? undefined,
        head: c.q("head") ?? undefined,
        untracked: c.q("untracked") === "1",
        context: c.q("context") ? Number(c.q("context")) : undefined,
      }),
    );
  }
  if (op === "show" && get) {
    const file = c.q("path");
    if (!file) throw new HttpError(400, "path is required.");
    const content = await G.showFile(cwd, c.q("rev") === ":" ? ":" : (c.q("rev") ?? "HEAD"), file);
    return json({ content, exists: content !== null });
  }

  if (op === "stage" && post) {
    await G.stage(cwd, paths(c.body));
    return json({ ok: true });
  }
  if (op === "unstage" && post) {
    await G.unstage(cwd, paths(c.body));
    return json({ ok: true });
  }
  if (op === "discard" && post) {
    await G.discard(cwd, paths(c.body), { all: c.body.all === true });
    return json({ ok: true });
  }
  if (op === "apply" && post) {
    await G.applyPatch(cwd, String(c.body.patch ?? ""), { cached: c.body.cached === true, reverse: c.body.reverse === true });
    return json({ ok: true });
  }
  if (op === "commit" && post) return json(await G.commit(cwd, String(c.body.message ?? ""), { amend: c.body.amend === true, signoff: c.body.signoff === true, noVerify: c.body.noVerify === true }));

  if (op === "branches" && get) return json({ branches: await G.branches(cwd) });
  if (op === "checkout" && post) {
    if (c.body.remote) await G.checkoutRemote(cwd, String(c.body.name ?? ""));
    else await G.checkout(cwd, String(c.body.name ?? ""));
    return json({ ok: true });
  }
  if (op === "branch" && post) {
    await G.createBranch(cwd, String(c.body.name ?? ""), { from: c.body.from, checkout: c.body.checkout !== false });
    return json({ ok: true }, 201);
  }
  if (op === "branch" && c.method === "DELETE") {
    await G.deleteBranch(cwd, String(c.q("name") ?? ""), c.q("force") === "1");
    return json({ ok: true });
  }
  if (op === "merge" && post) return json(await G.merge(cwd, String(c.body.name ?? "")));
  if (op === "abort" && post) {
    const which = String(c.body.operation ?? "");
    if (!["merge", "rebase", "cherry-pick", "revert"].includes(which)) throw new HttpError(400, "Bad operation.");
    await G.abortOperation(cwd, which as any);
    return json({ ok: true });
  }
  if (op === "resolve" && post) {
    if (c.body.side !== "ours" && c.body.side !== "theirs") throw new HttpError(400, "side must be ours or theirs.");
    await G.resolveConflict(cwd, String(c.body.path ?? ""), c.body.side);
    return json({ ok: true });
  }

  if (op === "log" && get) {
    return json({
      commits: await G.log(cwd, { limit: c.q("limit") ? Number(c.q("limit")) : 100, skip: c.q("skip") ? Number(c.q("skip")) : 0, path: c.q("path") ?? undefined, all: c.q("all") === "1", rev: c.q("rev") ?? undefined }),
    });
  }
  if (op === "commit" && get && sub) return json(await G.commitDetail(cwd, sub));

  if (op === "fetch" && post) return json({ output: await G.fetchRemote(cwd) });
  if (op === "pull" && post) return json({ output: await G.pull(cwd, c.body.mode === "rebase" ? "rebase" : c.body.mode === "merge" ? "merge" : "ff-only") });
  if (op === "push" && post) return json({ output: await G.push(cwd, { setUpstream: c.body.setUpstream === true, forceWithLease: c.body.forceWithLease === true, remote: c.body.remote, branch: c.body.branch }) });

  if (op === "gh" && get) return json(await G.ghStatus(cwd));
  if (op === "publish" && post) return json(await G.publishRepo(cwd, { name: String(c.body.name ?? ""), visibility: c.body.visibility, description: typeof c.body.description === "string" ? c.body.description : undefined }));

  if (op === "stash" && get) return json({ stashes: await G.stashList(cwd) });
  if (op === "stash" && post && !sub) return json({ output: await G.stashPush(cwd, { message: c.body.message, includeUntracked: c.body.includeUntracked === true }) });
  if (op === "stash" && post && sub) {
    if (!["apply", "pop", "drop"].includes(sub)) throw new HttpError(400, "Bad stash operation.");
    return json({ output: await G.stashOp(cwd, sub as any, Number(c.body.index)) });
  }

  if (op === "worktrees" && get) return json({ worktrees: await G.worktrees(cwd) });
  return null;
};
