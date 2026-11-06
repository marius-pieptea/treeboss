/**
 * Git routes the UI needs beyond the base set.
 *
 * `/api/git/:root/t/<op>` runs path-taking operations from the repository's TOP-LEVEL. The base routes run from
 * the workspace directory, which is a subdirectory when a monorepo package is opened as its own workspace; git
 * then reads `a/b.ts` as relative to that subdirectory, while `git status` printed it relative to the top. The
 * UI speaks status's paths, so it uses these.
 */
import { resolveRoot } from "../../workspaces";
import * as G from "../../git/ops";
import { runGit } from "../../git/run";
import { HttpError, json, type RouteModule } from "../http";

const SHA = /^[0-9a-f]{7,40}$/i;

export const gitExtRoutes: RouteModule = async (c) => {
  let m = c.match(/^\/api\/git\/([^/]+)\/detach$/);
  if (m && c.method === "POST") {
    const root = resolveRoot(m[1]);
    const sha = String(c.body.sha ?? "");
    if (!SHA.test(sha)) throw new HttpError(400, "Bad commit.");
    const r = await runGit(["switch", "--detach", sha], { cwd: root.dir, timeoutMs: 60_000 });
    if (r.code !== 0) throw new G.GitError((r.stderr.toString() || r.stdout.toString()).trim().split("\n").slice(0, 6).join("\n"), 400);
    return json({ ok: true });
  }

  m = c.match(/^\/api\/git\/([^/]+)\/t\/([a-z]+)$/);
  if (!m) return null;
  const root = resolveRoot(m[1]);
  const info = await G.repoInfo(root.dir);
  if (!info.isRepo || !info.root) throw new G.GitError("Not a git repository.", 400);
  const top = info.root;
  const op = m[2];
  const paths = (): string[] => {
    if (!Array.isArray(c.body.paths)) throw new HttpError(400, "paths must be an array.");
    return c.body.paths.map(String);
  };

  if (op === "stage" && c.method === "POST") {
    await G.stage(top, paths());
    return json({ ok: true });
  }
  if (op === "unstage" && c.method === "POST") {
    await G.unstage(top, paths());
    return json({ ok: true });
  }
  if (op === "discard" && c.method === "POST") {
    await G.discard(top, paths(), { all: c.body.all === true });
    return json({ ok: true });
  }
  if (op === "apply" && c.method === "POST") {
    await G.applyPatch(top, String(c.body.patch ?? ""), { cached: c.body.cached === true, reverse: c.body.reverse === true });
    return json({ ok: true });
  }
  if (op === "log" && c.method === "GET") {
    // `--all` also walks refs/stash, whose internal commits ("index on main", "untracked files on main") are
    // implementation detail, not history. Exclude them.
    const limit = Math.min(Math.max(Number(c.q("limit") ?? 60) || 60, 1), 500);
    const skip = Math.max(Number(c.q("skip") ?? 0) || 0, 0);
    const path = c.q("path");
    const args = ["log", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e", `-n${limit}`, `--skip=${skip}`, "--date-order", ...(c.q("all") === "1" ? ["--exclude=refs/stash", "--all"] : []), ...(path ? ["--", path] : [])];
    const r = await runGit(args, { cwd: top, timeoutMs: 30_000 });
    if (r.code !== 0) {
      const err = r.stderr.toString();
      // An empty repository has no commits: an empty log, not an error.
      if (/does not have any commits|unknown revision|bad default revision/i.test(err)) return json({ commits: [] });
      throw new G.GitError(err.trim().split("\n").slice(0, 4).join("\n"), 400);
    }
    const commits = r.stdout
      .toString()
      .split("\x1e")
      .map((rec) => rec.replace(/^\n/, ""))
      .filter(Boolean)
      .map((line) => {
        const [sha, parents, author, email, date, refs, subject] = line.split("\x1f");
        return { sha, short: sha.slice(0, 7), parents: parents ? parents.split(" ") : [], author, email, date, refs: refs ? refs.split(", ").filter(Boolean) : [], subject };
      });
    return json({ commits });
  }
  if (op === "diff" && c.method === "GET") {
    return json(
      await G.diff(top, {
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
  return null;
};
