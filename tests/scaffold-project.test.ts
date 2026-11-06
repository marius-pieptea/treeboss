import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { normalizeCloneUrl, projectCloneArgv, repoFolderName, setScaffoldRunner, startProject, waitJob, type Runner } from "../src/scaffold/run";
import { makeDir } from "./helpers";

afterEach(() => setScaffoldRunner(null));

const real = (argv: string[], cwd: string) => {
  const p = Bun.spawnSync(argv, { cwd });
  return { code: p.exitCode ?? 1, output: `${p.stdout}${p.stderr}` };
};

describe("clone URLs", () => {
  test("accepts GitHub shorthand, https, ssh and scp-style", () => {
    expect(normalizeCloneUrl("acme/app")).toBe("https://github.com/acme/app");
    expect(normalizeCloneUrl("https://gitlab.com/acme/sub/app.git")).toBe("https://gitlab.com/acme/sub/app.git");
    expect(normalizeCloneUrl("git@github.com:acme/app.git")).toBe("git@github.com:acme/app.git");
    expect(normalizeCloneUrl("ssh://git@host.dev/acme/app")).toBe("ssh://git@host.dev/acme/app");
  });
  test("refuses options, credentials, local paths and code-running transports", () => {
    for (const x of ["", "--upload-pack=x", "ext::sh -c id", "file:///etc", "/tmp/repo", "../x", "https://user:pw@github.com/a/b", "https://localhost/a/b", "http://github.com/a/b", "a b/c", "https://github.com/a/../b"]) expect(() => normalizeCloneUrl(x)).toThrow();
  });
  test("folder name comes from the repo", () => {
    expect(repoFolderName("https://github.com/acme/app.git")).toBe("app");
    expect(repoFolderName("git@github.com:acme/my app.git")).toBe("my-app");
  });
  test("a full clone keeps history; shallow is opt-in; the URL follows --", () => {
    const full = projectCloneArgv({ url: "https://github.com/a/b", ref: "dev" }, ".");
    expect(full).not.toContain("--depth");
    expect(full.slice(-5)).toEqual(["--branch", "dev", "--", "https://github.com/a/b", "."]);
    expect(full.indexOf("--") < full.indexOf("https://github.com/a/b")).toBe(true);
    expect(projectCloneArgv({ url: "https://github.com/a/b" }, ".", true)).toContain("--depth");
  });
});

describe("startProject", () => {
  test("empty folder: creates missing parents, git init, first commit, opens a workspace", async () => {
    const root = makeDir();
    const target = path.join(root, "projects", "deep", "fresh");
    const job = await waitJob(startProject({ kind: "empty", target }).id);
    expect(job.status).toBe("done");
    expect(job.workspaceId).toBeTruthy();
    expect(fs.existsSync(path.join(target, ".git"))).toBe(true);
    expect(real(["git", "log", "--oneline"], target).output).toContain("Initial commit");
  });
  test("empty folder without git init stays plain", async () => {
    const target = path.join(makeDir(), "plain");
    const job = await waitJob(startProject({ kind: "empty", target, gitInit: false }).id);
    expect(job.status).toBe("done");
    expect(fs.readdirSync(target)).toEqual([]);
  });
  test("refuses a folder that already has files", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    expect(() => startProject({ kind: "empty", target: dir })).toThrow(/not empty/);
  });
  test("clone: runs a full clone in the new folder and keeps what git made", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (argv, o) => {
      calls.push(argv);
      if (argv.includes("clone")) {
        fs.mkdirSync(path.join(o.cwd, ".git"));
        fs.writeFileSync(path.join(o.cwd, "README.md"), "hi");
        return { code: 0, output: "cloned" };
      }
      return { code: 0, output: "" };
    };
    setScaffoldRunner(runner);
    const target = path.join(makeDir(), "nested", "app");
    const job = await waitJob(startProject({ kind: "clone", target, url: "acme/app", ref: "main" }).id);
    expect(job.status).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("https://github.com/acme/app");
    expect(fs.existsSync(path.join(target, ".git"))).toBe(true);
    expect(job.workspaceId).toBeTruthy();
  });
  test("a failed clone fails the job and removes the folder it made", async () => {
    setScaffoldRunner(async () => ({ code: 128, output: "fatal: repository not found" }));
    const target = path.join(makeDir(), "gone");
    const job = await waitJob(startProject({ kind: "clone", target, url: "acme/missing" }).id);
    expect(job.status).toBe("failed");
    expect(job.log.join("\n")).toContain("repository not found");
    expect(fs.existsSync(target)).toBe(false);
  });
  test("a bad URL or ref is refused before anything is created", () => {
    const target = path.join(makeDir(), "x");
    expect(() => startProject({ kind: "clone", target, url: "--bad" })).toThrow();
    expect(() => startProject({ kind: "clone", target, url: "acme/app", ref: "a..b" })).toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });
});
