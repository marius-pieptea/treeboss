import { beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { docMeta, parseFrontMatter } from "../src/docs/frontmatter";
import { THRESHOLDS, classify, clearStalenessCache, headSha, normalizeCovers, pageStaleness, parseNameStatus } from "../src/docs/staleness";
import { makeDir, makeRepo, sh } from "./helpers";

const commit = (dir: string, msg: string) => sh(`git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm ${JSON.stringify(msg)} && git rev-parse HEAD`, dir);
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const meta = (commitSha: string | null, covers: string[]) => docMeta(parseFrontMatter(`---\ncovers: ${JSON.stringify(covers)}\n${commitSha ? `generated:\n  commit: ${commitSha}\n  by: test\n` : ""}---\n`).data);

let dir: string;
let base: string;
beforeEach(() => {
  clearStalenessCache();
  dir = makeRepo({ "src/a.ts": "a\n", "src/b.ts": "b\n", "lib/c.ts": "c\n", "docs/arch.md": "# Arch\n" });
  base = sh("git rev-parse HEAD", dir);
});

describe("pageStaleness", () => {
  test("fresh at the recorded commit", async () => {
    const st = await pageStaleness(dir, meta(base, ["src/**"]));
    expect(st).toMatchObject({ state: "fresh", commitsBehind: 0, filesChanged: 0, generatedCommit: base });
  });

  test("HEAD moving on without touching the covered paths stays fresh", async () => {
    write(dir, "lib/c.ts", "c2\n");
    commit(dir, "elsewhere");
    const st = await pageStaleness(dir, meta(base, ["src/**"]));
    expect(st).toMatchObject({ state: "fresh", filesChanged: 0, commitsBehind: 0, headBehind: 1 });
  });

  test("a change under the covers makes it drift, and names the file", async () => {
    write(dir, "src/a.ts", "a2\n");
    commit(dir, "touch a");
    const st = await pageStaleness(dir, meta(base, ["src/**"]));
    expect(st.state).toBe("drifting");
    expect(st).toMatchObject({ commitsBehind: 1, filesChanged: 1 });
    expect(st.files).toEqual([{ path: "src/a.ts", status: "modified" }]);
  });

  test("renames count from either side, and are reported as renames", async () => {
    sh("git mv src/b.ts src/b2.ts", dir);
    commit(dir, "rename inside");
    let st = await pageStaleness(dir, meta(base, ["src/**"]));
    expect(st.files).toEqual([{ path: "src/b2.ts", from: "src/b.ts", status: "renamed" }]);
    // moving a file OUT of the covered paths is a change to them too
    sh("git mv src/a.ts lib/a.ts", dir);
    commit(dir, "move out");
    st = await pageStaleness(dir, meta(base, ["src/**"]));
    expect(st.files.map((f) => f.from ?? f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    // and moving one IN
    clearStalenessCache();
    const into = await pageStaleness(dir, meta(base, ["lib/**"]));
    expect(into.files.some((f) => f.path === "lib/a.ts")).toBe(true);
  });

  test("deleted files count as changes", async () => {
    fs.rmSync(path.join(dir, "src/b.ts"));
    commit(dir, "delete b");
    const st = await pageStaleness(dir, meta(base, ["src/b.ts"]));
    expect(st.state).toBe("drifting");
    expect(st.files).toEqual([{ path: "src/b.ts", status: "deleted" }]);
  });

  test("a directory or a plain file in covers works without a glob", async () => {
    write(dir, "src/a.ts", "a2\n");
    commit(dir, "touch a");
    expect((await pageStaleness(dir, meta(base, ["src"]))).filesChanged).toBe(1);
    expect((await pageStaleness(dir, meta(base, ["src/"]))).filesChanged).toBe(1);
    expect((await pageStaleness(dir, meta(base, ["src/a.ts"]))).filesChanged).toBe(1);
    expect((await pageStaleness(dir, meta(base, ["src/b.ts"]))).filesChanged).toBe(0);
    expect((await pageStaleness(dir, meta(base, ["lib"]))).filesChanged).toBe(0);
  });

  test("a lot of change in a lot of commits is stale", async () => {
    for (let i = 0; i < THRESHOLDS.driftingCommits + 1; i++) {
      write(dir, `src/gen${i}.ts`, `${i}\n`);
      commit(dir, `add ${i}`);
    }
    const st = await pageStaleness(dir, meta(base, ["src/**"]));
    expect(st.state).toBe("stale");
    expect(st.commitsBehind).toBe(THRESHOLDS.driftingCommits + 1);
  });

  test("the file list is capped but the count is not", async () => {
    for (let i = 0; i < 130; i++) write(dir, `src/many/f${i}.ts`, `${i}\n`);
    commit(dir, "many");
    const st = await pageStaleness(dir, meta(base, ["src/**"]));
    expect(st.filesChanged).toBe(130);
    expect(st.files).toHaveLength(100);
    expect(st.state).toBe("stale");
  });

  test("uncommitted work in the tree is not a change: only commits are", async () => {
    write(dir, "src/a.ts", "dirty\n");
    expect((await pageStaleness(dir, meta(base, ["src/**"]))).state).toBe("fresh");
  });

  test("no claim, no verdict: unmanaged", async () => {
    expect((await pageStaleness(dir, meta(null, ["src/**"]))).state).toBe("unmanaged");
    const noCovers = await pageStaleness(dir, meta(base, []));
    expect(noCovers.state).toBe("unmanaged");
    expect(noCovers.reason).toMatch(/covers/);
    expect((await pageStaleness(dir, meta(base, ["../outside"]))).state).toBe("unmanaged");
  });

  test("a commit that is not in the repository is unknown, not stale", async () => {
    const st = await pageStaleness(dir, meta("deadbeefdeadbeef", ["src/**"]));
    expect(st.state).toBe("unknown");
    expect(st.reason).toMatch(/not in this repository/);
    expect((await pageStaleness(dir, meta("not-a-sha", ["src/**"]))).state).toBe("unknown");
  });

  test("outside a git repository it says unknown", async () => {
    const plain = makeDir();
    const st = await pageStaleness(plain, meta("abcdef1", ["src/**"]));
    expect(st.state).toBe("unknown");
    expect(st.reason).toMatch(/git/i);
  });

  test("an abbreviated recorded commit resolves", async () => {
    write(dir, "src/a.ts", "a2\n");
    commit(dir, "touch a");
    const st = await pageStaleness(dir, meta(base.slice(0, 9), ["src/**"]));
    expect(st.state).toBe("drifting");
  });

  test("results are cached per HEAD and invalidate when HEAD moves", async () => {
    const m = meta(base, ["src/**"]);
    expect((await pageStaleness(dir, m)).state).toBe("fresh");
    write(dir, "src/a.ts", "a2\n");
    commit(dir, "touch a");
    expect((await pageStaleness(dir, m)).state).toBe("drifting");
  });
});

describe("pieces", () => {
  test("classification thresholds", () => {
    expect(classify(0, 0)).toBe("fresh");
    expect(classify(3, 0)).toBe("fresh");
    expect(classify(1, 1)).toBe("drifting");
    expect(classify(THRESHOLDS.driftingCommits, THRESHOLDS.driftingFiles)).toBe("drifting");
    expect(classify(THRESHOLDS.driftingCommits + 1, 1)).toBe("stale");
    expect(classify(1, THRESHOLDS.driftingFiles + 1)).toBe("stale");
  });

  test("name-status parsing", () => {
    expect(parseNameStatus("M\ta.ts\nA\tb.ts\nD\tc.ts\nR087\told.ts\tnew.ts\n")).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "b.ts", status: "added" },
      { path: "c.ts", status: "deleted" },
      { path: "new.ts", from: "old.ts", status: "renamed" },
    ]);
  });

  test("covers entries are cleaned and escapes dropped", () => {
    const d = makeRepo({ "src/a.ts": "a\n" });
    expect(normalizeCovers(d, ["./src", "src/**", "README.md", "/abs/x", "../up", "a/../b", " ", "src"])).toEqual(["src/**", "README.md", "abs/x"]);
  });

  test("head of a repository, null outside one", async () => {
    expect(await headSha(dir)).toBe(base);
    expect(await headSha(makeDir())).toBeNull();
  });
});
