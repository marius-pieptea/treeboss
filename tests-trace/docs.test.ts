import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START docs\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END docs\n"); });
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { attach, copyAttachments, detach, docsBlock, estimatePath, estimateSession, INLINE_FILE_CAP, listAttached, markDelivered } from "../src/docs/attach";
import { backlinksFor } from "../src/docs/backlinks";
import { checkPage, dirtyFiles, getRun, planRun, resolveHarness, startGeneration } from "../src/docs/generate";
import { docMeta, parseFrontMatter } from "../src/docs/frontmatter";
import { clearStalenessCache, headSha } from "../src/docs/staleness";
import { createDocsFolder, createPage, docsDirOf, guardDocsPath, listPages, markCurrent, nextAdrNumber, overview, readPage, setDocsDir, validateDocsDir, writePage } from "../src/docs/store";
import { setSetting } from "../src/settings";
import { handoff } from "../src/sessions/handoff";
import { createLead, getSession, interruptAll, readLog, setTurnRunner } from "../src/sessions/manager";
import { Workspaces } from "../src/workspaces";
import { makeDir, makeRepo, resetState, settled, sh } from "./helpers";

const TOKEN = "docs-test-token";
const ok = (output: string, over: Partial<TurnResult> = {}): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "", ...over });
const commit = (dir: string, msg: string) => sh(`git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm ${JSON.stringify(msg)} && git rev-parse HEAD`, dir);
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const page = (head: string, covers = ["src/**"], body = "# Architecture\n\nThe daemon owns sessions.\n") => `---\ntitle: Architecture\ncovers:\n${covers.map((c) => `  - ${c}`).join("\n")}\ngenerated:\n  commit: ${head}\n  at: 2026-10-08T10:00:00.000Z\n  by: claude/opus\nstatus: draft\n---\n\n${body}`;

beforeEach(() => {
  resetState();
  clearStalenessCache();
  listAttached("-"); // makes sure the tables exist
  getRun("-");
  db().exec("DELETE FROM session_docs; DELETE FROM docs_runs;");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

/** A repo with source and one page generated at the first commit. */
function project() {
  const dir = makeRepo({ "src/a.ts": "a\n", "src/b.ts": "b\n", "README.md": "# demo\n" });
  const head = sh("git rev-parse HEAD", dir);
  write(dir, "docs/architecture.md", page(head));
  commit(dir, "docs");
  return { dir, base: head, head: sh("git rev-parse HEAD", dir) };
}

describe("where the docs live", () => {
  test("the folder setting is validated and per workspace", () => {
    expect(validateDocsDir("./documentation/")).toBe("documentation");
    expect(validateDocsDir("a\\b")).toBe("a/b");
    for (const bad of ["", "/", "..", "a/../b", "node_modules/x", ".git/docs", "a/./b"]) expect(() => validateDocsDir(bad)).toThrow();
    const ws = Workspaces.open(makeDir());
    expect(docsDirOf(ws.id)).toEqual({ dir: "docs", custom: false });
    expect(setDocsDir(ws.id, "manual")).toEqual({ dir: "manual", custom: true });
    expect(docsDirOf(ws.id).dir).toBe("manual");
    expect(docsDirOf(null).dir).toBe("docs");
    expect(setDocsDir(ws.id, null)).toEqual({ dir: "docs", custom: false });
  });
});

describe("paths", () => {
  test("only markdown under the docs folder, nothing that escapes", () => {
    const dir = makeRepo({ "docs/a.md": "# a\n", "other/b.md": "x\n", "docs/img.png": "x" });
    expect(guardDocsPath(dir, "docs", "docs/a.md")).toBe("docs/a.md");
    expect(guardDocsPath(dir, "docs", "/docs/sub/new.mdx")).toBe("docs/sub/new.mdx");
    expect(() => guardDocsPath(dir, "docs", "other/b.md")).toThrow(/Only files under docs/);
    expect(() => guardDocsPath(dir, "docs", "docs/../other/b.md")).toThrow(/escapes/);
    expect(() => guardDocsPath(dir, "docs", "docs/img.png")).toThrow(/markdown/);
    expect(() => guardDocsPath(dir, "docs", "docs-evil/a.md")).toThrow(/Only files under docs/);
    expect(() => guardDocsPath(dir, "docs", "docs")).toThrow();
    expect(() => guardDocsPath(dir, "docs", "docs/.git/x.md")).toThrow(/\.git/);
    expect(() => guardDocsPath(dir, "docs", "docs/a\0.md")).toThrow();
    expect(guardDocsPath(dir, "docs", "docs", { allowDir: true })).toBe("docs");
  });

  test("a symlink out of the workspace is refused", () => {
    const dir = makeRepo({ "docs/a.md": "# a\n" });
    const outside = makeDir();
    write(outside, "secret.md", "# secret\n");
    fs.symlinkSync(outside, path.join(dir, "docs", "link"));
    expect(() => guardDocsPath(dir, "docs", "docs/link/secret.md")).toThrow(/symlink/);
    expect(listPages(dir, "docs").pages.map((p) => p.path)).toEqual(["docs/a.md"]);
  });
});

describe("listing and creating", () => {
  test("pages carry their front matter, kind and whether they can be checked", () => {
    const dir = makeRepo({ "README.md": "x\n" });
    write(dir, "docs/index.md", "# Home\n\nWelcome to the project.\n");
    write(dir, "docs/architecture.md", page("abc1234"));
    write(dir, "docs/guides/setup.md", "---\ntitle: Setup\n---\nInstall it.\n");
    write(dir, "docs/decisions/0001-use-bun.md", "# 1. Use Bun\n");
    write(dir, "docs/broken.md", "---\ntitle: [oops\n---\n# Broken\n");
    write(dir, "docs/notes.txt", "not markdown");
    write(dir, "docs/node_modules/x/readme.md", "# no\n");
    write(dir, "docs/.hidden/y.md", "# no\n");
    const { pages } = listPages(dir, "docs");
    const by = Object.fromEntries(pages.map((p) => [p.path, p]));
    expect(Object.keys(by).sort()).toEqual(["docs/architecture.md", "docs/broken.md", "docs/decisions/0001-use-bun.md", "docs/guides/setup.md", "docs/index.md"]);
    expect(by["docs/index.md"]).toMatchObject({ kind: "index", title: "Home", summary: "Welcome to the project.", managed: false, folder: "" });
    expect(by["docs/architecture.md"]).toMatchObject({ kind: "page", title: "Architecture", managed: true });
    expect(by["docs/guides/setup.md"]).toMatchObject({ title: "Setup", folder: "guides", managed: false });
    expect(by["docs/decisions/0001-use-bun.md"].kind).toBe("adr");
    expect(by["docs/broken.md"].frontMatterError).toBeTruthy();
  });

  test("looking never creates anything", () => {
    const dir = makeDir();
    const ov = overview(dir, "docs");
    expect(ov).toMatchObject({ exists: false, pages: [], nextAdr: "0001" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("the folder is made only on request, with an index, and never over existing pages", () => {
    const dir = makeDir();
    expect(createDocsFolder(dir, "docs", "Demo")).toEqual({ dir: "docs", created: ["docs/index.md"] });
    expect(fs.readFileSync(path.join(dir, "docs/index.md"), "utf-8")).toContain("# Demo");
    fs.writeFileSync(path.join(dir, "docs/index.md"), "# mine\n");
    expect(createDocsFolder(dir, "docs").created).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "docs/index.md"), "utf-8")).toBe("# mine\n");
    const other = makeDir();
    write(other, "docs/existing.md", "# e\n");
    expect(createDocsFolder(other, "docs").created).toEqual([]);
    expect(fs.existsSync(path.join(other, "docs/index.md"))).toBe(false);
  });

  test("new pages and decision records", () => {
    const dir = makeDir();
    expect(createPage(dir, "docs", { path: "guides/setup", title: "Setup" })).toEqual({ path: "docs/guides/setup.md", title: "Setup" });
    expect(createPage(dir, "docs", { title: "Release process" }).path).toBe("docs/release-process.md");
    expect(createPage(dir, "docs", { path: "docs/already-prefixed.md" }).path).toBe("docs/already-prefixed.md");
    expect(() => createPage(dir, "docs", { path: "guides/setup.md" })).toThrow(/already exists/);
    expect(() => createPage(dir, "docs", {})).toThrow(/path or a title/);
    expect(() => createPage(dir, "docs", { path: "../escape.md" })).toThrow();
    const a = createPage(dir, "docs", { kind: "adr", title: "Use Bun for the daemon" });
    expect(a).toEqual({ path: "docs/decisions/0001-use-bun-for-the-daemon.md", title: "0001. Use Bun for the daemon" });
    const b = createPage(dir, "docs", { kind: "adr", title: "Store state in SQLite" });
    expect(b.path).toBe("docs/decisions/0002-store-state-in-sqlite.md");
    expect(nextAdrNumber(dir, "docs")).toBe("0003");
    const text = fs.readFileSync(path.join(dir, a.path), "utf-8");
    for (const h of ["## Status", "## Context", "## Decision", "## Consequences"]) expect(text).toContain(h);
    expect(listPages(dir, "docs").pages.find((p) => p.path === a.path)?.kind).toBe("adr");
  });
});

describe("reading and writing", () => {
  test("write with the optimistic lock, create only on request, report broken front matter", () => {
    const dir = makeRepo({ "docs/a.md": "# a\n" });
    const r = readPage(dir, "docs", "docs/a.md");
    expect(r).toMatchObject({ title: "a", eol: "lf", frontMatterError: null });
    const w = writePage(dir, "docs", "docs/a.md", "# a2\n", { expectedMtime: r.mtime });
    expect(w.frontMatterError).toBeNull();
    fs.utimesSync(path.join(dir, "docs/a.md"), new Date(), new Date(Date.now() + 5000));
    expect(() => writePage(dir, "docs", "docs/a.md", "# a3\n", { expectedMtime: r.mtime })).toThrow(/changed on disk/);
    expect(() => writePage(dir, "docs", "docs/new.md", "# n\n")).toThrow(/No such file/);
    writePage(dir, "docs", "docs/new.md", "# n\n", { create: true });
    expect(writePage(dir, "docs", "docs/a.md", "---\ntitle: [x\n---\n").frontMatterError).toBeTruthy();
    expect(() => writePage(dir, "docs", "docs/big.md", "x".repeat(2 * 1024 * 1024 + 1), { create: true })).toThrow(/larger than 2 MB/);
    expect(() => readPage(dir, "docs", "docs/missing.md")).toThrow(/No such page/);
    expect(() => readPage(dir, "docs", "README.md")).toThrow();
  });

  test("marking a page current changes only its generated key", () => {
    const { dir, head } = project();
    const before = fs.readFileSync(path.join(dir, "docs/architecture.md"), "utf-8");
    write(dir, "src/a.ts", "a2\n");
    const tip = commit(dir, "touch a");
    markCurrent(dir, "docs", "docs/architecture.md", tip);
    const after = fs.readFileSync(path.join(dir, "docs/architecture.md"), "utf-8");
    const m = docMeta(parseFrontMatter(after).data);
    expect(m.generated).toMatchObject({ commit: tip, by: "manual" });
    expect(m.covers).toEqual(["src/**"]);
    expect(parseFrontMatter(after).body).toBe(parseFrontMatter(before).body);
    write(dir, "docs/nocover.md", "# n\n");
    expect(() => markCurrent(dir, "docs", "docs/nocover.md", head)).toThrow(/covers/);
  });

  test("the overview revision follows the pages", () => {
    const dir = makeRepo({ "docs/a.md": "# a\n" });
    const r1 = overview(dir, "docs").rev;
    expect(overview(dir, "docs").rev).toBe(r1);
    fs.appendFileSync(path.join(dir, "docs/a.md"), "more\n");
    expect(overview(dir, "docs").rev).not.toBe(r1);
  });
});

describe("attached to a session", () => {
  test("a reference block names the page, its freshness and what it covers; the next turn carries it once", async () => {
    const { dir } = project();
    write(dir, "src/a.ts", "a2\n");
    commit(dir, "touch a");
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return ok("fine");
    });
    const s = createLead({ prompt: "start", engine: "fake", cwd: dir, docs: [{ path: "docs/architecture.md" }] });
    await settled(s.id);
    expect(prompts[0]).toContain("# Attached project files");
    expect(prompts[0]).toContain("`docs/architecture.md`: Architecture [drifting: 1 covered file changed in 1 commit");
    expect(prompts[0]).toContain("The daemon owns sessions.");
    expect(prompts[0]).toContain("Covers: src/**");
    expect(prompts[0]).not.toContain("# Architecture\n\nThe daemon owns sessions.\n\n```");
    expect(listAttached(s.id)[0].delivered).toBe(true);
    expect(await docsBlock(s.id)).toBeNull();
    expect(await docsBlock(s.id, { all: true })).toContain("docs/architecture.md");
  });

  test("a stale page is marked so the agent checks it", async () => {
    const { dir } = project();
    for (let i = 0; i < 12; i++) {
      write(dir, `src/g${i}.ts`, `${i}\n`);
      commit(dir, `g${i}`);
    }
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    await settled(s.id);
    attach(s.id, "docs/architecture.md");
    expect(await docsBlock(s.id)).toContain("[STALE: 12 covered files changed in 12 commits");
  });

  test("inline pastes the page up to a cap, ref is much cheaper", async () => {
    const dir = makeRepo({ "docs/small.md": "# Small\n\nTiny.\n" });
    write(dir, "docs/huge.md", `# Huge\n\n${"word ".repeat(10_000)}\n`);
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    await settled(s.id);
    attach(s.id, "docs/small.md", { mode: "inline" });
    attach(s.id, "docs/huge.md", { mode: "inline" });
    const block = (await docsBlock(s.id))!;
    expect(block).toContain("Pasted in full:");
    expect(block).toContain("Tiny.");
    expect(block).toContain("(truncated here: read the file for the rest)");
    expect(block.length).toBeLessThan(INLINE_FILE_CAP + 2000 + 400);
    const ws = Workspaces.open(dir);
    const ref = await estimatePath(dir, "docs/huge.md", "ref", "docs");
    const inl = await estimatePath(dir, "docs/huge.md", "inline", "docs");
    expect(inl.truncated).toBe(true);
    expect(inl.tokens).toBeGreaterThan(ref.tokens * 10);
    expect((await estimateSession(s.id)).tokens).toBeGreaterThan(0);
    expect(ws.id).toBeTruthy();
  });

  test("attaching validates, detaches, and rejects pages outside the docs folder", async () => {
    const dir = makeRepo({ "docs/a.md": "# a\n", "README.md": "x\n" });
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    await settled(s.id);
    expect(() => attach(s.id, "README.md")).toThrow(/Only files under docs/);
    expect(() => attach(s.id, "docs/missing.md")).toThrow(/does not exist/);
    expect(() => attach(s.id, "docs/a.md", { mode: "weird" as any })).toThrow(/Unknown attach mode/);
    expect(() => attach("nope", "docs/a.md")).toThrow(/No session/);
    attach(s.id, "docs/a.md");
    expect(detach(s.id, "docs/a.md")).toBe(true);
    expect(detach(s.id, "docs/a.md")).toBe(false);
  });

  test("a handoff names them and carries them over", async () => {
    const { dir } = project();
    setTurnRunner(async () => ok("did things"));
    const s = createLead({ prompt: "start", engine: "fake", cwd: dir, docs: [{ path: "docs/architecture.md" }] });
    await settled(s.id);
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return ok("continuing");
    });
    const h = await handoff(s.id, { useModel: false });
    await settled(h.session.id);
    expect(prompts[0]).toContain("Attached documentation");
    expect(prompts[0]).toContain("docs/architecture.md");
    expect(listAttached(h.session.id).map((a) => a.doc_path)).toEqual(["docs/architecture.md"]);
    expect(copyAttachments(s.id, h.session.id)).toBe(1);
  });

  test("a generation run's targets are not pasted into context", async () => {
    const { dir } = project();
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    await settled(s.id);
    attach(s.id, "docs/architecture.md", { purpose: "generate" });
    expect(await docsBlock(s.id, { all: true })).toBeNull();
    markDelivered(s.id);
  });
});

describe("planning a run", () => {
  test("the prompt carries HEAD, the harness, the contract and the targets", async () => {
    const { dir, head } = project();
    setSetting("docs_engine", "codex");
    setSetting("docs_model", "gpt-x");
    const p = await planRun(dir, null, { kind: "architecture" });
    expect(p.refresh).toBe(true);
    expect(p.targets).toMatchObject([{ path: "docs/architecture.md", exists: true, state: "fresh" }]);
    expect(p.head).toBe(head);
    for (const needle of [`commit: ${head}`, "by: codex/gpt-x", "DOCS_TOUCHED:", "<!-- keep -->", "Write only inside `docs/`", "covers", "Refresh documentation"]) expect(p.prompt).toContain(needle);
    expect(p.title).toContain("refresh architecture");
    const fresh = await planRun(dir, null, { kind: "runbook" });
    expect(fresh.refresh).toBe(false);
    expect(fresh.targets[0]).toMatchObject({ path: "docs/runbook.md", exists: false });
    expect(fresh.prompt).toContain("Write documentation");
  });

  test("the harness: dialog choice, then settings, then the app default", () => {
    expect(resolveHarness({}).by).toBe("claude");
    setSetting("docs_engine", "codex");
    setSetting("docs_model", "gpt-x");
    expect(resolveHarness({})).toMatchObject({ engine: "codex", model: "gpt-x", by: "codex/gpt-x" });
    expect(resolveHarness({ engine: "cursor" })).toMatchObject({ engine: "cursor", model: null, by: "cursor" });
    expect(resolveHarness({ engine: "cursor", model: "m" }).by).toBe("cursor/m");
    expect(resolveHarness({ agent: "scribe" })).toMatchObject({ engine: null, by: "agent scribe" });
  });

  test("module pages need a topic, refresh needs pages, decision records get the next number", async () => {
    const { dir } = project();
    await expect(planRun(dir, null, { kind: "module" })).rejects.toThrow(/topic/);
    const m = await planRun(dir, null, { kind: "module", input: "The Session Manager" });
    expect(m.targets[0].path).toBe("docs/modules/the-session-manager.md");
    await expect(planRun(dir, null, { kind: "refresh" })).rejects.toThrow(/needs pages/);
    await expect(planRun(dir, null, { kind: "refresh", pages: ["docs/missing.md"] })).rejects.toThrow(/does not exist/);
    await expect(planRun(dir, null, { kind: "refresh", stale: true })).rejects.toThrow(/nothing to refresh/);
    await expect(planRun(dir, null, { kind: "nope" as any })).rejects.toThrow(/Unknown kind/);
    createPage(dir, "docs", { kind: "adr", title: "First" });
    const a = await planRun(dir, null, { kind: "adr", input: "pick a database" });
    expect(a.prompt).toContain("docs/decisions/0002-<short-slug>.md");
    expect(a.prompt).toContain("pick a database");
    expect(a.targets).toEqual([]);
    const conv = await planRun(dir, null, { kind: "adr", sessionId: "s_x" });
    expect(conv.prompt).toContain("the decision this conversation reached");
  });

  test("refreshing the stale pages lists what changed, worst first", async () => {
    const { dir, base } = project();
    write(dir, "docs/other.md", page(base, ["src/b.ts"], "# Other\n"));
    commit(dir, "other");
    write(dir, "src/b.ts", "b2\n");
    commit(dir, "touch b");
    for (let i = 0; i < 12; i++) {
      write(dir, `src/g${i}.ts`, `${i}\n`);
      commit(dir, `g${i}`);
    }
    const p = await planRun(dir, null, { kind: "refresh", stale: true });
    expect(p.targets.map((t) => t.path)).toEqual(["docs/architecture.md", "docs/other.md"]);
    expect(p.targets[0].state).toBe("stale");
    expect(p.targets[1].state).toBe("drifting");
    expect(p.targets[1].changed).toEqual(["src/b.ts"]);
    expect(p.prompt).toContain("`src/b.ts`");
    expect(p.prompt).toContain("Pages to refresh:");
  });

  test("it says to start with CodeGraph only when there is an index, and to plan first only when asked", async () => {
    const { dir } = project();
    expect((await planRun(dir, null, { kind: "overview" })).prompt).not.toContain("codegraph_explore");
    fs.mkdirSync(path.join(dir, ".codegraph"));
    const p = await planRun(dir, null, { kind: "overview", planFirst: true });
    expect(p.prompt).toContain("codegraph_explore");
    expect(p.prompt).toContain("## Plan first");
    expect((await planRun(dir, null, { kind: "overview" })).prompt).not.toContain("## Plan first");
  });

  test("outside a git repository it tells the agent to leave the commit out", async () => {
    const dir = makeDir();
    const p = await planRun(dir, null, { kind: "overview" });
    expect(p.head).toBeNull();
    expect(p.prompt).toContain("There is no git history here");
  });
});

describe("checking a page", () => {
  const HEAD = "1a2b3c4d5e6f7a8b";
  test("a good page has no issues", () => {
    expect(checkPage(page(HEAD), { head: HEAD, before: null, adr: false })).toEqual([]);
  });
  test("each way a page can break the contract is named", () => {
    const codes = (text: string, ctx: Partial<Parameters<typeof checkPage>[1]> = {}) => checkPage(text, { head: HEAD, before: null, adr: false, ...ctx }).map((i) => i.code);
    expect(codes("# Plain\n")).toEqual(["no-front-matter"]);
    expect(codes("---\ntitle: [x\n---\n")).toEqual(["front-matter-error"]);
    expect(codes("---\ntitle: T\n---\n")).toEqual(["missing-covers", "missing-generated"]);
    expect(codes(page("ffffffffffff"))).toEqual(["commit-mismatch"]);
    expect(codes(page(HEAD.slice(0, 8)))).toEqual([]);
    expect(codes(`${page(HEAD)}<!-- keep -->\nopen\n`)).toEqual(["keep-unbalanced"]);
    expect(codes("---\ntitle: T\n---\n", { adr: true })).toEqual([]);
    expect(codes("---\ntitle: T\ncovers: [a]\n---\n", { head: null })).toEqual([]);
  });
  test("a lost keep block is caught against what the page was before", () => {
    const before = page(HEAD, ["src/**"], "# A\n\n<!-- keep -->\nours\n<!-- /keep -->\n");
    expect(checkPage(before, { head: HEAD, before, adr: false })).toEqual([]);
    expect(checkPage(page(HEAD, ["src/**"], "# A\n"), { head: HEAD, before, adr: false }).map((i) => i.code)).toEqual(["keep-altered"]);
  });
});

describe("a generation run", () => {
  test("touched pages are found, checked and reported; the files are left exactly as the agent wrote them", async () => {
    const { dir, head } = project();
    const kept = "<!-- keep -->\nPager rota is in the wiki.\n<!-- /keep -->";
    write(dir, "docs/architecture.md", page(head, ["src/**"], `# Architecture\n\nOld text.\n\n${kept}\n`));
    commit(dir, "add keep");
    const tip = sh("git rev-parse HEAD", dir);
    let written = "";
    setTurnRunner(async (o) => {
      written = page(tip, ["src/**", "README.md"], `# Architecture\n\nNew text about src.\n\n${kept}\n`);
      write(o.cwd, "docs/architecture.md", written);
      write(o.cwd, "docs/runbook.md", page(tip, ["src/**"], "# Runbook\n"));
      return ok("Done.\nDOCS_TOUCHED: docs/architecture.md, docs/runbook.md");
    });
    const r = await startGeneration(dir, null, { kind: "refresh", pages: ["docs/architecture.md"], engine: "fake" });
    expect(r.targets[0].path).toBe("docs/architecture.md");
    await settled(r.session.id);
    await Bun.sleep(150); // the after-turn bookkeeping runs just behind the settle
    const run = getRun(r.session.id)!;
    expect(run).toMatchObject({ kind: "refresh", docs_dir: "docs", head: tip });
    expect(run.result!.touched.map((t) => [t.path, t.created, t.issues])).toEqual([
      ["docs/architecture.md", false, []],
      ["docs/runbook.md", true, []],
    ]);
    expect(run.result!.stray).toEqual([]);
    expect(run.result!.reportedOnly).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "docs/architecture.md"), "utf-8")).toBe(written);
    const log = readLog(r.session.id).map((e: any) => e.text ?? "").join("\n");
    expect(log).toContain("[docs] 2 pages written: docs/architecture.md, docs/runbook.md");
    expect(listAttached(r.session.id).map((a) => [a.doc_path, a.purpose])).toEqual([["docs/architecture.md", "generate"]]);
  });

  test("it reports a dropped keep block, a page with no front matter, a stray file and a claim that nothing backs", async () => {
    const { dir, head } = project();
    const kept = "<!-- keep -->\nHuman words.\n<!-- /keep -->";
    write(dir, "docs/architecture.md", page(head, ["src/**"], `# A\n\n${kept}\n`));
    commit(dir, "keep");
    setTurnRunner(async (o) => {
      write(o.cwd, "docs/architecture.md", page(sh("git rev-parse HEAD", o.cwd), ["src/**"], "# A\n\nRewritten, keep block gone.\n"));
      write(o.cwd, "docs/plain.md", "# Plain\n");
      write(o.cwd, "src/oops.ts", "changed code\n");
      return ok("DOCS_TOUCHED: docs/architecture.md, docs/plain.md, docs/ghost.md");
    });
    const r = await startGeneration(dir, null, { kind: "refresh", pages: ["docs/architecture.md"], engine: "fake" });
    await settled(r.session.id);
    await Bun.sleep(150);
    const res = getRun(r.session.id)!.result!;
    const byPath = Object.fromEntries(res.touched.map((t) => [t.path, t.issues.map((i) => i.code)]));
    expect(byPath["docs/architecture.md"]).toEqual(["keep-altered"]);
    expect(byPath["docs/plain.md"]).toEqual(["no-front-matter"]);
    expect(res.stray).toEqual(["src/oops.ts"]);
    expect(res.reportedOnly).toEqual(["docs/ghost.md"]);
    const log = readLog(r.session.id).map((e: any) => e.text ?? "").join("\n");
    expect(log).toContain("human-written");
    expect(log).toContain("files outside docs/ changed");
    expect(log).toContain("reported docs/ghost.md but nothing changed there");
  });

  test("work that was already uncommitted before the run is not blamed on it", async () => {
    const { dir, head } = project();
    write(dir, "src/wip.ts", "mine\n");
    write(dir, "docs/mine.md", "# mine\n");
    expect(await dirtyFiles(dir)).toContain("src/wip.ts");
    setTurnRunner(async (o) => {
      write(o.cwd, "docs/overview.md", page(head, ["src/**"], "# Overview\n"));
      return ok("DOCS_TOUCHED: docs/overview.md");
    });
    const r = await startGeneration(dir, null, { kind: "overview", page: "docs/overview.md", engine: "fake" });
    await settled(r.session.id);
    await Bun.sleep(150);
    const res = getRun(r.session.id)!.result!;
    expect(res.touched.map((t) => t.path)).toEqual(["docs/overview.md"]);
    expect(res.stray).toEqual([]);
  });

  test("plan first starts the session read-only; the harness comes from the settings", async () => {
    const { dir } = project();
    setSetting("docs_engine", "fake");
    setSetting("docs_model", "m1");
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return ok("a plan");
    });
    const r = await startGeneration(dir, null, { kind: "overview", planFirst: true });
    await settled(r.session.id);
    expect(getSession(r.session.id)).toMatchObject({ mode: "plan", engine: "fake", model: "m1" });
    expect(prompts[0]).toContain("## Plan first");
    expect(prompts[0]).toContain("by: fake/m1");
  });

  test("a decision record can be taken from the conversation already open", async () => {
    const { dir } = project();
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return ok("ok");
    });
    const s = createLead({ prompt: "let's decide on a database", engine: "fake", cwd: dir });
    await settled(s.id);
    const r = await startGeneration(dir, null, { kind: "adr", sessionId: s.id, input: "we chose sqlite" });
    expect(r.session.id).toBe(s.id);
    await settled(s.id);
    expect(prompts[1]).toContain("the decision this conversation reached");
    expect(getRun(s.id)).toMatchObject({ kind: "adr" });
    await expect(startGeneration(dir, null, { kind: "adr", sessionId: "nope" })).rejects.toThrow(/No session/);
  });

  test("an ordinary session has no run, and nothing is logged for one", async () => {
    const { dir } = project();
    setTurnRunner(async (o) => {
      write(o.cwd, "docs/x.md", "# x\n");
      return ok("done");
    });
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    await settled(s.id);
    await Bun.sleep(100);
    expect(getRun(s.id)).toBeNull();
    expect(readLog(s.id).map((e: any) => e.text ?? "").join("\n")).not.toContain("[docs]");
  });
});

describe("backlinks", () => {
  test("specs and roadmap items that name a page are found", () => {
    const dir = makeRepo({ "docs/architecture.md": "# a\n", "docs/guides/setup.md": "# s\n" });
    write(dir, "specs/001-export/spec.md", "# Export\n\nSee docs/architecture.md for the layout.\n");
    write(dir, "specs/001-export/plan.md", "# Plan\n\nNo mention here.\n");
    write(dir, "ROADMAP.md", "# Roadmap\n\n- [ ] Rework [the layout](docs/architecture.md)\n- [ ] Write the setup guide (guides/setup.md)\n");
    write(dir, "docs/other.md", "docs/architecture.md mentioned inside docs is not a backlink here\n");
    const a = backlinksFor(dir, "docs", "docs/architecture.md");
    expect(a.map((b) => [b.path, b.kind, b.line])).toEqual([["specs/001-export/spec.md", "spec", 3], ["ROADMAP.md", "roadmap", 3]]);
    const s = backlinksFor(dir, "docs", "docs/guides/setup.md");
    expect(s.map((b) => b.path)).toEqual(["ROADMAP.md"]);
    expect(backlinksFor(makeDir(), "docs", "docs/x.md")).toEqual([]);
  });
});

describe("HTTP routes", () => {
  let srv: ReturnType<typeof startServer>;
  let dir: string;
  let root: string;
  beforeAll(() => {
    srv = startServer({ port: 0, token: TOKEN });
  });
  afterAll(() => srv.stop());
  beforeEach(() => {
    dir = makeRepo({ "src/a.ts": "a\n", "README.md": "# demo\n" });
    root = Workspaces.open(dir).id;
  });

  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  };

  test("overview of a project with no docs creates nothing; folder, page, read, write, conflict", async () => {
    let r = await call("GET", `/api/docs/${root}`);
    expect(r.status).toBe(200);
    expect(r.data.docs).toMatchObject({ dir: "docs", exists: false, pages: [] });
    expect(r.data.head).toBe(sh("git rev-parse HEAD", dir));
    expect(fs.existsSync(path.join(dir, "docs"))).toBe(false);
    r = await call("POST", `/api/docs/${root}/folder`, {});
    expect(r.status).toBe(201);
    expect(r.data.created).toEqual(["docs/index.md"]);
    r = await call("POST", `/api/docs/${root}/pages`, { path: "architecture", title: "Architecture" });
    expect(r.status).toBe(201);
    expect(r.data.path).toBe("docs/architecture.md");
    expect((await call("POST", `/api/docs/${root}/pages`, { path: "architecture" })).status).toBe(409);
    r = await call("GET", `/api/docs/${root}/page?path=docs/architecture.md`);
    expect(r.status).toBe(200);
    expect(r.data.page).toMatchObject({ title: "Architecture", eol: "lf" });
    expect(r.data.staleness.state).toBe("unmanaged");
    const w = await call("PUT", `/api/docs/${root}/page`, { path: "docs/architecture.md", content: "# Changed\n", expectedMtime: r.data.page.mtime });
    expect(w.status).toBe(200);
    fs.utimesSync(path.join(dir, "docs/architecture.md"), new Date(), new Date(Date.now() + 5000));
    const c = await call("PUT", `/api/docs/${root}/page`, { path: "docs/architecture.md", content: "# Again\n", expectedMtime: r.data.page.mtime });
    expect(c.status).toBe(409);
    expect(c.data.conflict).toBe(true);
  });

  test("freshness, backlinks and mark-current over HTTP", async () => {
    const head = sh("git rev-parse HEAD", dir);
    write(dir, "docs/architecture.md", page(head));
    write(dir, "ROADMAP.md", "- [ ] Revisit docs/architecture.md\n");
    commit(dir, "docs");
    write(dir, "src/a.ts", "a2\n");
    const tip = commit(dir, "touch a");
    let r = await call("GET", `/api/docs/${root}`);
    expect(r.data.staleness["docs/architecture.md"]).toMatchObject({ state: "drifting", filesChanged: 1 });
    r = await call("GET", `/api/docs/${root}/page?path=docs/architecture.md`);
    expect(r.data.staleness.files).toEqual([{ path: "src/a.ts", status: "modified" }]);
    expect(r.data.backlinks.map((b: any) => b.path)).toEqual(["ROADMAP.md"]);
    r = await call("POST", `/api/docs/${root}/page/current`, { path: "docs/architecture.md" });
    expect(r.status).toBe(200);
    expect(r.data.head).toBe(tip);
    r = await call("GET", `/api/docs/${root}/page?path=docs/architecture.md`);
    expect(r.data.staleness.state).toBe("fresh");
    expect((await call("GET", `/api/docs/${root}/rev`)).data).toMatchObject({ exists: true, head: tip });
  });

  test("paths outside the docs folder are refused", async () => {
    for (const p of ["README.md", "docs/../README.md", "/etc/passwd.md", "docs/a.png"]) {
      const r = await call("GET", `/api/docs/${root}/page?path=${encodeURIComponent(p)}`);
      expect([400, 403]).toContain(r.status);
    }
    expect((await call("PUT", `/api/docs/${root}/page`, { path: "src/a.ts", content: "x", create: true })).status).toBe(403);
    expect((await call("GET", `/api/docs/${root}/page?path=docs/nope.md`)).status).toBe(404);
  });

  test("the docs folder is a per-workspace setting", async () => {
    let r = await call("PUT", `/api/docs/${root}/dir`, { dir: "documentation" });
    expect(r.data).toMatchObject({ dir: "documentation", custom: true });
    r = await call("POST", `/api/docs/${root}/pages`, { path: "x" });
    expect(r.data.path).toBe("documentation/x.md");
    expect((await call("PUT", `/api/docs/${root}/dir`, { dir: "../up" })).status).toBe(400);
    r = await call("PUT", `/api/docs/${root}/dir`, { dir: null });
    expect(r.data).toMatchObject({ dir: "docs", custom: false });
  });

  test("preview shows what would run and starts nothing; generate starts a session", async () => {
    const before = (db().prepare("SELECT COUNT(*) AS n FROM sessions").get() as any).n;
    let r = await call("POST", `/api/docs/${root}/generate/preview`, { kind: "overview" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ kind: "overview", docsDir: "docs", refresh: false });
    expect(r.data.prompt).toContain("DOCS_TOUCHED");
    expect((db().prepare("SELECT COUNT(*) AS n FROM sessions").get() as any).n).toBe(before);
    expect((await call("POST", `/api/docs/${root}/generate/preview`, { kind: "bogus" })).status).toBe(400);
    expect((await call("POST", `/api/docs/${root}/generate/preview`, { kind: "refresh" })).status).toBe(400);
    setTurnRunner(async () => ok("fine"));
    r = await call("POST", `/api/docs/${root}/generate`, { kind: "overview", engine: "fake" });
    expect(r.status).toBe(201);
    expect(r.data.session.title).toContain("Docs: write overview");
    await settled(r.data.session.id);
    expect((await call("GET", `/api/docs/${root}/runs/${r.data.session.id}`)).data.run).toMatchObject({ kind: "overview" });
    expect((await call("GET", `/api/docs/${root}/runs/s_none`)).status).toBe(404);
  });

  test("a session's attached pages over HTTP, with their cost", async () => {
    write(dir, "docs/a.md", "# A\n\nText.\n");
    setTurnRunner(async () => ok("fine"));
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    await settled(s.id);
    let r = await call("POST", `/api/sessions/${s.id}/docs`, { path: "docs/a.md", mode: "inline" });
    expect(r.status).toBe(201);
    expect(r.data.attached).toMatchObject({ doc_path: "docs/a.md", mode: "inline" });
    expect(r.data.estimate.tokens).toBeGreaterThan(0);
    r = await call("GET", `/api/sessions/${s.id}/docs`);
    expect(r.data.attached).toHaveLength(1);
    expect((await call("GET", `/api/docs/${root}/estimate?path=docs/a.md&mode=ref`)).data.tokens).toBeGreaterThan(0);
    r = await call("DELETE", `/api/sessions/${s.id}/docs?path=docs/a.md`);
    expect(r.data.removed).toBe(true);
    expect((await call("POST", `/api/sessions/${s.id}/docs`, { path: "README.md" })).status).toBe(403);
    expect((await call("GET", "/api/sessions/s_none/docs")).status).toBe(404);
  });
});

describe("nothing else changes", () => {
  test("headSha is null outside a repository", async () => {
    expect(await headSha(makeDir())).toBeNull();
  });
});
