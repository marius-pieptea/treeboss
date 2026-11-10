import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { setSetting } from "../src/settings";
import { HydraPairs } from "../src/hydra/pairs";
import {
  SessionError,
  close,
  createChild,
  createLead,
  descendantsOf,
  diff,
  getSession,
  hasWorkingChildren,
  interrupt,
  interruptAll,
  listForCaller,
  merge,
  readLog,
  recoverOnStartup,
  reapIdle,
  send,
  setTurnRunner,
  viewSession,
  wait,
} from "../src/sessions/manager";
import { executeSubagentTool } from "../src/sessions/tools";
import { finalizingOf } from "../src/sessions/finalize";
import { makeDir, makeRepo, resetState, settled, sh } from "./helpers";

beforeEach(() => {
  resetState();
  setTurnRunner(null);
});

// Turns left sleeping by a test must not eat the next test's concurrency budget.
afterEach(async () => {
  await interruptAll();
  // The runner override is module state shared with every other test file in this process.
  setTurnRunner(null);
});

const lead = (prompt: string, over: Record<string, unknown> = {}) => createLead({ prompt, engine: "fake", cwd: makeDir(), ...over } as any);

describe("a lead session", () => {
  test("runs a turn: answer, engine session id, usage, cost and a replayable log", async () => {
    const s0 = lead("SAY hello\nSAY the answer");
    expect(s0.status).toBe("running");
    const s = await settled(s0.id);
    expect(s.status).toBe("idle");
    expect(s.last_output).toBe("the answer");
    expect(s.cli_session_id).toMatch(/^fake-/);
    expect(s.turns).toBe(1);
    expect(s.output_tokens).toBe(20);
    expect(s.cache_read_tokens).toBe(100);
    expect(s.cost_usd).toBeCloseTo(0.001, 5);
    const log = readLog(s.id).map((l) => l.text);
    expect(log.some((l) => l.includes("hello"))).toBe(true);
    expect(log.some((l) => /done after/.test(l))).toBe(true);
    const turn = db().prepare("SELECT status, output FROM turns WHERE session_id = ?").get(s.id) as any;
    expect(turn).toMatchObject({ status: "completed", output: "the answer" });
  });

  test("a follow-up resumes the engine's own session", async () => {
    const s0 = await settled(lead("SAY first").id);
    send({ operator: true }, s0.id, "ECHO_RESUME");
    const s = await settled(s0.id);
    expect(s.last_output).toBe(`resume=yes session=${s0.cli_session_id}`);
    expect(s.turns).toBe(2);
    expect(s.cost_usd).toBeCloseTo(0.002, 5);
  });

  test("a failing turn is failed with its reason, and can still be followed up", async () => {
    const s = await settled(lead("FAIL out of cheese").id);
    expect(s.status).toBe("failed");
    expect(s.last_error).toContain("out of cheese");
    send({ operator: true }, s.id, "SAY recovered");
    expect((await settled(s.id)).status).toBe("idle");
  });

  test("interrupting stops the turn but keeps the engine session, so a follow-up resumes it", async () => {
    const s0 = lead("SAY started\nSLEEP 20000\nSAY never");
    // wait until the engine has reported its session id (it is persisted while the turn runs)
    for (let i = 0; i < 100 && !getSession(s0.id)!.cli_session_id; i++) await Bun.sleep(50);
    expect(getSession(s0.id)!.cli_session_id).toBeTruthy();
    const t0 = Date.now();
    await interrupt({ operator: true }, s0.id);
    expect(Date.now() - t0).toBeLessThan(8000);
    const s = await settled(s0.id);
    expect(s.status).toBe("idle");
    expect(s.last_error).toContain("interrupted");
    expect((db().prepare("SELECT status FROM turns WHERE session_id = ?").get(s.id) as any).status).toBe("cancelled");
    expect(readLog(s.id).map((l) => l.text)).toContain(`[${s0.engine}] stopped by user`);
    send({ operator: true }, s.id, "ECHO_RESUME");
    expect((await settled(s.id)).last_output).toContain("resume=yes");
  });

  test("a refused resume is retried once, fresh, instead of failing the follow-up", async () => {
    const s0 = await settled(lead("SAY first").id);
    send({ operator: true }, s0.id, "REJECT_RESUME\nSAY recovered fresh");
    const s = await settled(s0.id);
    expect(s.status).toBe("idle");
    expect(s.last_output).toBe("recovered fresh");
    const turns = db().prepare("SELECT status FROM turns WHERE session_id = ? ORDER BY seq").all(s.id) as any[];
    expect(turns.map((t) => t.status)).toEqual(["completed", "failed", "completed"]); // the refused one is recorded, then the retry
  });

  test("refuses nonsense up front", () => {
    expect(() => createLead({ prompt: "  ", cwd: makeDir() })).toThrow(/prompt/);
    expect(() => createLead({ prompt: "x", cwd: "/definitely/not/here" })).toThrow(/not found/);
    expect(() => createLead({ prompt: "x", engine: "nope", cwd: makeDir() })).toThrow(/Unknown engine/);
    expect(() => createLead({ prompt: "x", engine: "fake", pairId: "ghost", cwd: makeDir() })).toThrow(/No Hydra pair/);
  });

  test("an engine that cannot reach the MCP tools is refused as a pair's lead rather than handed a contract it cannot keep", () => {
    const pair = HydraPairs.create({ title: "NoMcp", lead_engine: "opencode", heads_engine: "fake" });
    // opencode may not be installed on the test machine; either refusal is the right outcome, but never a started session.
    expect(() => createLead({ prompt: "x", cwd: makeDir(), pairId: pair.id })).toThrow(/cannot lead a Hydra pair|not installed/);
  });

  test("a lead can run in its own worktree", async () => {
    const repo = makeRepo();
    const s = await settled(lead("WRITE note.txt from lead", { cwd: repo, isolate: true }).id);
    expect(s.isolation).toBe("worktree");
    expect(s.cwd).not.toBe(repo);
    expect(fs.existsSync(path.join(repo, "note.txt"))).toBe(false); // the operator's checkout is untouched
    expect(viewSession(s).changes).toMatchObject({ files: 1 });
  });

  test("pair settings seed the lead's engine, model and effort; explicit flags win", () => {
    const pair = HydraPairs.create({ title: "P", lead_engine: "fake", lead_model: "m-lead", lead_effort: "high", heads_engine: "fake" });
    const a = lead("SAY x", { pairId: pair.title });
    expect(a).toMatchObject({ engine: "fake", model: "m-lead", effort: "high", pair_id: pair.id });
    const b = lead("SAY x", { pairId: pair.id, model: "override" });
    expect(b.model).toBe("override");
  });
});

describe("subagents", () => {
  const withLead = async (extra: Record<string, unknown> = {}) => {
    const repo = makeRepo();
    const l = await settled(lead("SAY ready", { cwd: repo, ...extra }).id);
    return { repo, l };
  };
  const spawn = (parent: string, brief: string, over: Record<string, unknown> = {}) => createChild({ caller: { sessionId: parent }, brief, ...over });

  test("a child works in its own worktree and its answer comes back through wait", async () => {
    const { repo, l } = await withLead();
    const c = spawn(l.id, "WRITE child.txt made by child\nSAY child done", { title: "child job" });
    expect(c).toMatchObject({ parent_id: l.id, root_id: l.id, depth: 1, isolation: "worktree", status: "running" });
    expect(c.branch).toMatch(/^trb\/fake\//);
    const res = await wait({ sessionId: l.id }, [c.id], { timeoutSec: 30 });
    expect(res.timedOut).toBe(false);
    const done = res.sessions[0];
    expect(done.status).toBe("idle");
    expect(done.last_output).toBe("child done");
    expect(viewSession(done).changes).toMatchObject({ files: 1, insertions: 1 });
    expect(fs.existsSync(path.join(repo, "child.txt"))).toBe(false); // not in the parent until merged
    expect(done.cwd.startsWith(repo)).toBe(false);
  });

  test("a finished head's diff stats are stored the first time a read measures them, so later reads do not run git", async () => {
    const { l } = await withLead();
    const c = spawn(l.id, "WRITE child.txt made by child");
    await settled(c.id);
    await finalizingOf(c.id);
    const stored = () => (db().prepare("SELECT changes_json FROM sessions WHERE id = ?").get(c.id) as { changes_json: string | null }).changes_json;
    db().prepare("UPDATE sessions SET changes_json = NULL WHERE id = ?").run(c.id); // a row from before finalization stored its stats
    expect(viewSession(getSession(c.id)!).changes).toMatchObject({ files: 1, insertions: 1 });
    expect(JSON.parse(stored()!)).toMatchObject({ files: 1, insertions: 1 });
    // The stored answer is what later reads return, even once the branch has moved on.
    fs.writeFileSync(path.join(getSession(c.id)!.cwd, "more.txt"), "more\n");
    sh("git add -A && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm more", getSession(c.id)!.cwd);
    expect(viewSession(getSession(c.id)!).changes).toMatchObject({ files: 1, insertions: 1 });
  });

  test("a finished head with no changes stores that answer too", async () => {
    const { l } = await withLead();
    const c = spawn(l.id, "SAY nothing to do");
    await settled(c.id);
    await finalizingOf(c.id);
    db().prepare("UPDATE sessions SET changes_json = NULL WHERE id = ?").run(c.id);
    expect(viewSession(getSession(c.id)!).changes).toBeNull();
    expect((db().prepare("SELECT changes_json FROM sessions WHERE id = ?").get(c.id) as { changes_json: string | null }).changes_json).toBe("null");
  });

  test("merge applies the child's work to the parent's checkout, uncommitted, once", async () => {
    const { repo, l } = await withLead();
    const c = spawn(l.id, "WRITE child.txt made by child");
    await settled(c.id);
    const m = merge({ sessionId: l.id }, c.id);
    expect(m).toMatchObject({ merged: true, files: ["child.txt"] });
    expect(fs.readFileSync(path.join(repo, "child.txt"), "utf-8")).toBe("made by child\n");
    expect(sh("git status --short", repo)).toBe("?? child.txt");
    expect(merge({ sessionId: l.id }, c.id).merged).toBe(false); // second time: already merged
    // Closing a merged child deletes its branch: it has landed.
    const closed = await close({ sessionId: l.id }, c.id);
    expect(closed.status).toBe("closed");
    expect(closed.branch).toBeNull();
    expect(sh("git branch --list 'trb/*'", repo)).toBe("");
  });

  test("a head sent more work after a merge merges again: only the commits since the last merge", async () => {
    const { repo, l } = await withLead();
    const c = spawn(l.id, "WRITE first.txt one");
    await settled(c.id);
    expect(merge({ sessionId: l.id }, c.id)).toMatchObject({ merged: true, files: ["first.txt"] });
    send({ sessionId: l.id }, c.id, "WRITE second.txt two");
    await settled(c.id);
    await finalizingOf(c.id);
    expect(viewSession(getSession(c.id)!).merged).toBe(false); // new commits: not merged any more
    const again = merge({ sessionId: l.id }, c.id);
    expect(again).toMatchObject({ merged: true, files: ["second.txt"] }); // first.txt is not re-applied
    expect(fs.readFileSync(path.join(repo, "second.txt"), "utf-8")).toBe("two\n");
    expect(merge({ sessionId: l.id }, c.id).message).toMatch(/no commits since/);
  });

  test("closing a merged head that committed more since keeps its branch", async () => {
    const { repo, l } = await withLead();
    const c = spawn(l.id, "WRITE first.txt one");
    await settled(c.id);
    merge({ sessionId: l.id }, c.id);
    send({ sessionId: l.id }, c.id, "WRITE second.txt two");
    await settled(c.id);
    const closed = await close({ sessionId: l.id }, c.id);
    expect(closed.branch).toBeTruthy();
    expect(sh(`git branch --list '${closed.branch}'`, repo)).toContain(closed.branch!);
  });

  test("closing an UNMERGED child with changes keeps its branch", async () => {
    const { repo, l } = await withLead();
    const c = spawn(l.id, "WRITE child.txt x");
    await settled(c.id);
    const closed = await close({ sessionId: l.id }, c.id);
    expect(closed.branch).toBeTruthy();
    expect(sh(`git branch --list '${closed.branch}'`, repo)).toContain(closed.branch!);
  });

  test("an agent that commits for itself is not mistaken for one that did nothing", async () => {
    const { repo, l } = await withLead();
    const c = spawn(l.id, "WRITE own.txt self-committed\nGIT_COMMIT my own commit");
    const done = await settled(c.id);
    expect(done.head_sha).not.toBe(done.base_sha); // the recorded head follows the branch tip
    expect(viewSession(done).changes).toMatchObject({ files: 1, insertions: 1 });
    expect((await diff(c.id))!.diff).toContain("+self-committed");
    // Closing without merging must KEEP the branch: it holds real commits.
    const closed = await close({ sessionId: l.id }, c.id);
    expect(closed.branch).toBeTruthy();
    expect(sh(`git branch --list '${closed.branch}'`, repo)).toContain(closed.branch!);
    expect(sh(`git log --format=%s -1 ${closed.branch}`, repo)).toBe("my own commit");
  });

  test("an agent that commits for itself can still be merged", async () => {
    const { repo, l } = await withLead();
    const c = spawn(l.id, "WRITE own.txt self-committed\nGIT_COMMIT my own commit");
    await settled(c.id);
    expect(merge({ sessionId: l.id }, c.id)).toMatchObject({ merged: true, files: ["own.txt"] });
    expect(fs.readFileSync(path.join(repo, "own.txt"), "utf-8")).toBe("self-committed\n");
  });

  test("merge conflicts apply nothing and say how to resolve", async () => {
    const { repo, l } = await withLead();
    const c = spawn(l.id, "WRITE a.txt child version");
    await settled(c.id);
    fs.writeFileSync(path.join(repo, "a.txt"), "parent edit\n");
    const m = merge({ sessionId: l.id }, c.id);
    expect(m.merged).toBe(false);
    expect(m.message).toContain("Nothing was changed");
    expect(m.message).toContain("git merge");
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf-8")).toBe("parent edit\n");
  });

  test("diff shows the child's committed change", async () => {
    const { l } = await withLead();
    const c = spawn(l.id, "WRITE child.txt hello");
    await settled(c.id);
    expect((await diff(c.id))!.diff).toContain("+hello");
  });

  test("a diff longer than the cap is cut there, and says so", async () => {
    const { l } = await withLead();
    const c = spawn(l.id, "BASH head -c 300000 /dev/zero | tr '\\0' a > big.txt");
    await settled(c.id);
    const cut = await diff(c.id, 1000);
    expect(cut).toMatchObject({ truncated: true });
    expect(cut!.diff.length).toBeLessThanOrEqual(1000);
    expect(await diff(c.id, 10_000_000)).toMatchObject({ truncated: false });
  });

  test("in a directory that is not a repo, a child shares the parent's workspace by absolute path", async () => {
    const plain = makeDir();
    const l = await settled(lead("SAY ready", { cwd: plain }).id);
    const c = spawn(l.id, "SAY ok");
    expect(c.isolation).toBe("none");
    expect(c.cwd).not.toBe(plain); // a private scratch directory
    expect(c.base_cwd).toBe(plain);
    await settled(c.id);
    expect(() => merge({ sessionId: l.id }, c.id)).toThrow(/Nothing to merge/);
    await close({ sessionId: l.id }, c.id);
    expect(fs.existsSync(c.cwd)).toBe(false); // scratch is removed on close
  });

  test("isolate:false shares the workspace even inside a repo", async () => {
    const { l } = await withLead();
    expect(spawn(l.id, "SAY ok", { isolate: false }).isolation).toBe("none");
  });

  test("follow-ups resume the child with its context", async () => {
    const { l } = await withLead();
    const c = spawn(l.id, "SAY first");
    await settled(c.id);
    send({ sessionId: l.id }, c.id, "ECHO_RESUME");
    expect((await settled(c.id)).last_output).toContain("resume=yes");
  });

  test("ownership: a session can only manage the subagents it opened", async () => {
    const { l } = await withLead();
    const other = await settled(lead("SAY other").id);
    const c = spawn(l.id, "SAY ok");
    await settled(c.id);
    expect(() => send({ sessionId: other.id }, c.id, "hi")).toThrow(/belongs to another parent/);
    await expect(wait({ sessionId: other.id }, [c.id])).rejects.toThrow(/another parent/);
    await expect(close({ sessionId: other.id }, c.id)).rejects.toThrow(/another parent/);
    expect(listForCaller({ sessionId: other.id })).toEqual([]);
    expect(listForCaller({ sessionId: l.id }).map((s) => s.id)).toEqual([c.id]);
    expect(listForCaller({ operator: true }).length).toBeGreaterThanOrEqual(3);
  });

  test("depth: children may open grandchildren, grandchildren may not", async () => {
    const { l } = await withLead();
    const child = spawn(l.id, "SAY ok");
    await settled(child.id);
    const grand = spawn(child.id, "SAY ok");
    expect(grand.depth).toBe(2);
    expect(grand.subagents).toBe(0); // it will not be handed subagent tools it could not use
    await settled(grand.id);
    expect(() => spawn(grand.id, "SAY nope")).toThrow(/Depth limit/);
    setSetting("max_depth", "3");
    expect(spawn(grand.id, "SAY now ok").depth).toBe(3);
  });

  test("per-parent cap, and a pair's max_heads is a tighter one", async () => {
    setSetting("max_per_parent", "2");
    const { l } = await withLead();
    spawn(l.id, "SLEEP 1500");
    spawn(l.id, "SLEEP 1500");
    expect(() => spawn(l.id, "SAY x")).toThrow(/2 open subagent/);
    const pair = HydraPairs.create({ title: "cap1", lead_engine: "fake", heads_engine: "fake", max_heads: 1 });
    const l2 = await settled(lead("SAY ready", { pairId: pair.id }).id);
    spawn(l2.id, "SLEEP 1500");
    expect(() => spawn(l2.id, "SAY x")).toThrow(/1 open subagent/);
    await Bun.sleep(1700);
  });

  test("a preset name the pair does not use as an id resolves to the role labelled with it", async () => {
    const pair = HydraPairs.create({ title: "HP", lead_engine: "fake", roles: { "harry-potter": { engine: "fake", label: "Worker" } } });
    const l = await settled(lead("SAY ready", { pairId: pair.id }).id);
    expect(spawn(l.id, "SAY x", { role: "worker" })).toMatchObject({ role: "harry-potter" });
    expect(() => spawn(l.id, "SAY x", { role: "ghost" })).toThrow(/This pair's roles: harry-potter \("Worker"\)/);
  });

  test("an idle head with its work merged frees its slot; the refusal lists the heads that hold one", async () => {
    setSetting("max_per_parent", "2");
    const { l } = await withLead();
    const done = spawn(l.id, "WRITE a.txt a");
    await settled(done.id);
    await finalizingOf(done.id);
    const busy = spawn(l.id, "SLEEP 1500");
    let err = "";
    try {
      spawn(l.id, "SAY x");
    } catch (e: any) {
      err = e.message;
    }
    expect(err).toContain(`${done.id} (fake, idle, not merged)`);
    expect(err).toContain(`${busy.id} (fake, working)`);
    merge({ sessionId: l.id }, done.id);
    expect(spawn(l.id, "SAY x").status).toBe("running"); // the merged idle head no longer counts
    await Bun.sleep(1700);
  });

  test("daemon-wide concurrency cap", async () => {
    setSetting("max_concurrent", "2");
    const { l } = await withLead();
    spawn(l.id, "SLEEP 1500");
    spawn(l.id, "SLEEP 1500");
    expect(() => spawn(l.id, "SAY x")).toThrow(/2 turns are already running daemon-wide/);
    await Bun.sleep(1700);
  });

  test("a roles pair: the lead must pick a role, an unknown role is refused, and a role resolves its engine/model", async () => {
    const pair = HydraPairs.create({ title: "R", lead_engine: "fake", roles: { worker: { engine: "fake", model: "m-worker", effort: "low" }, scout: { engine: "fake" } } });
    const l = await settled(lead("SAY ready", { pairId: pair.id }).id);
    expect(() => spawn(l.id, "SAY x")).toThrow(/pass role/i);
    expect(() => spawn(l.id, "SAY x", { role: "ghost" })).toThrow(/Unknown role "ghost"/);
    const c = spawn(l.id, "SAY x", { role: "worker" });
    expect(c).toMatchObject({ role: "worker", engine: "fake", model: "m-worker", effort: "low", pair_id: pair.id });
    // role instructions ride along in the child's first prompt
    const first = (db().prepare("SELECT prompt FROM turns WHERE session_id = ?").get(c.id) as any).prompt as string;
    expect(first).toContain("# Role");
    expect(first).toContain("Implement exactly the slice"); // the library's `worker` text, since the pair stored none
  });

  test("a governing pair is binding: a lead may not swap a head's engine or model", async () => {
    const pair = HydraPairs.create({ title: "Bind", lead_engine: "fake", heads_engine: "fake", heads_model: "only-this" });
    const l = await settled(lead("SAY ready", { pairId: pair.id }).id);
    expect(() => spawn(l.id, "SAY x", { engine: "claude" })).toThrow(/outside the pair/);
    expect(() => spawn(l.id, "SAY x", { model: "other" })).toThrow(/outside the pair/);
    expect(spawn(l.id, "SAY x", { model: "only-this" }).model).toBe("only-this");
    // The operator (acting as the parent) is the one who may override.
    const op = createChild({ caller: { operator: true }, parentId: l.id, brief: "SAY x", model: "operator-pick" });
    expect(op.model).toBe("operator-pick");
  });

  test("a model only follows the engine it was chosen for", async () => {
    const pair = HydraPairs.create({ title: "M", lead_engine: "fake", lead_model: "lead-model", heads_engine: "fake", heads_model: "heads-model" });
    const l = await settled(lead("SAY ready", { pairId: pair.id }).id);
    expect(spawn(l.id, "SAY x").model).toBe("heads-model");
    // No pair: the child inherits the parent's engine, and the parent's model only with it.
    const bare = await settled(lead("SAY ready", { model: "bare-model" }).id);
    expect(spawn(bare.id, "SAY x").model).toBe("bare-model");
  });

  test("closing a lead closes its subagents and removes their worktrees", async () => {
    const { repo, l } = await withLead();
    const a = spawn(l.id, "WRITE a1.txt 1");
    const b = spawn(l.id, "SLEEP 30000");
    await settled(a.id);
    await close({ operator: true }, l.id);
    expect(getSession(a.id)!.status).toBe("closed");
    expect(getSession(b.id)!.status).toBe("closed"); // interrupted, then closed
    expect(descendantsOf(l.id, true)).toEqual([]);
    expect(fs.existsSync(a.worktree_root!)).toBe(false);
    expect(sh("git worktree list | wc -l", repo)).toBe("1");
  });

  test("a lead blocked on its heads is busy, not idle", async () => {
    const { l } = await withLead();
    const c = spawn(l.id, "SLEEP 800");
    expect(hasWorkingChildren(l.id)).toBe(true);
    await settled(c.id);
    expect(hasWorkingChildren(l.id)).toBe(false);
  });
});

describe("the tool surface", () => {
  test("create → wait → merge → close, as JSON text", async () => {
    const repo = makeRepo();
    const l = await settled(lead("SAY ready", { cwd: repo }).id);
    const caller = { sessionId: l.id };
    const created = JSON.parse(await executeSubagentTool("subagent_create", { brief: "WRITE t.txt tool\nSAY wrote", title: "t" }, caller));
    expect(created).toMatchObject({ status: "running", depth: 1, title: "t" });
    const waited = JSON.parse(await executeSubagentTool("subagent_wait", { ids: [created.id], timeout_sec: 20 }, caller));
    expect(waited.subagents[0]).toMatchObject({ status: "idle", output: "wrote", changes: { files: 1 } });
    expect(JSON.parse(await executeSubagentTool("subagent_merge", { id: created.id }, caller))).toMatchObject({ merged: true });
    expect(JSON.parse(await executeSubagentTool("subagent_list", {}, caller)).subagents).toHaveLength(1);
    expect(JSON.parse(await executeSubagentTool("subagent_list", { id: created.id }, caller)).brief).toContain("WRITE t.txt");
    expect(JSON.parse(await executeSubagentTool("subagent_close", { id: created.id }, caller)).status).toBe("closed");
    expect(JSON.parse(await executeSubagentTool("subagent_list", {}, caller)).subagents).toHaveLength(0);
  });

  test("refusals come back as `Error: …` text the agent can act on, never as a throw", async () => {
    const l = await settled(lead("SAY ready").id);
    const caller = { sessionId: l.id };
    expect(await executeSubagentTool("subagent_create", { brief: "" }, caller)).toMatch(/^Error: brief is required/);
    expect(await executeSubagentTool("subagent_send", { id: "s_nope", message: "x" }, caller)).toMatch(/^Error: No session/);
    expect(await executeSubagentTool("subagent_send", { message: "x" }, caller)).toBe("Error: id is required.");
    expect(await executeSubagentTool("subagent_bogus", {}, caller)).toMatch(/unknown subagent tool/);
  });

  test("wait on a still-running child reports it as running rather than blocking forever", async () => {
    const l = await settled(lead("SAY ready").id);
    const caller = { sessionId: l.id };
    const c = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SLEEP 2500" }, caller));
    const waited = JSON.parse(await executeSubagentTool("subagent_wait", { ids: [c.id], timeout_sec: 1 }, caller));
    expect(waited.still_running).toEqual([c.id]);
    expect(waited.note).toContain("again");
    await executeSubagentTool("subagent_wait", { ids: [c.id], timeout_sec: 20 }, caller);
  });

  test("wait mode any returns as soon as one finishes", async () => {
    const l = await settled(lead("SAY ready").id);
    const caller = { sessionId: l.id };
    const slow = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SLEEP 3000" }, caller));
    const fast = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SAY quick" }, caller));
    const t0 = Date.now();
    const waited = JSON.parse(await executeSubagentTool("subagent_wait", { ids: [slow.id, fast.id], mode: "any", timeout_sec: 20 }, caller));
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(waited.subagents.find((s: any) => s.id === fast.id).status).toBe("idle");
    expect(waited.still_running).toEqual([slow.id]);
    await executeSubagentTool("subagent_wait", { ids: [slow.id], timeout_sec: 20 }, caller);
  });

  test("wait mode any does not return at once on an answer an earlier wait already delivered: it waits for the next finisher", async () => {
    const l = await settled(lead("SAY ready").id);
    const caller = { sessionId: l.id };
    const fast = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SAY quick" }, caller));
    const first = JSON.parse(await executeSubagentTool("subagent_wait", { ids: [fast.id], mode: "any", timeout_sec: 20 }, caller));
    expect(first.already_delivered).toBeUndefined(); // new the first time
    const slow = JSON.parse(await executeSubagentTool("subagent_create", { brief: "SLEEP 800\nSAY slow done" }, caller));
    const t0 = Date.now();
    const second = JSON.parse(await executeSubagentTool("subagent_wait", { mode: "any", timeout_sec: 20 }, caller)); // ids omitted: both heads
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600); // it waited for slow instead of re-returning fast
    expect(second.subagents.find((s: any) => s.id === slow.id).status).toBe("idle");
    expect(second.already_delivered).toEqual([fast.id]);
  });
});

describe("lifecycle", () => {
  test("recoverOnStartup fails sessions the dead daemon left running, keeping their engine session id", async () => {
    const s = await settled(lead("SAY x").id);
    db().exec("UPDATE sessions SET status = 'running', cli_session_id = 'keep-me'");
    db().exec("UPDATE turns SET status = 'running'");
    const r = recoverOnStartup();
    expect(r.interrupted).toBe(1);
    const after = getSession(s.id)!;
    expect(after.status).toBe("failed");
    expect(after.last_error).toContain("daemon stopped");
    expect(after.cli_session_id).toBe("keep-me");
  });

  test("reapIdle closes stale subagents and orphans, never leads", async () => {
    const l = await settled(lead("SAY ready").id);
    const c = createChild({ caller: { sessionId: l.id }, brief: "SAY ok" });
    await settled(c.id);
    expect(reapIdle()).toBe(0); // fresh
    db().prepare("UPDATE sessions SET updated_at = datetime('now', '-7 hours') WHERE id = ?").run(c.id);
    expect(reapIdle()).toBe(1);
    expect(getSession(c.id)!.status).toBe("closed");
    expect(getSession(l.id)!.status).toBe("idle");
  });

  test("a running turn's tokens show before it settles (agy reports usage per step, its result comes minutes later)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setTurnRunner(async (opts) => {
      opts.onUsage?.({ kind: "turn", usage: { input: 9028, output: 1044, cacheRead: 5, cacheCreation: 0 } });
      await gate;
      return { success: true, output: "ok", sessionId: null, resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" };
    });
    const s = lead("SAY x");
    await new Promise((r) => setTimeout(r, 20));
    expect(viewSession(getSession(s.id)!).tokens).toEqual({ input: 9028, output: 1044, cache_read: 5 });
    release();
    const done = await settled(s.id);
    expect(viewSession(done).tokens).toEqual({ input: 0, output: 0, cache_read: 0 }); // usage: null at settle, so nothing is kept twice
  });

  test("a turn that crashes the runner is a failed turn, not a hung session", async () => {
    setTurnRunner(async () => {
      throw new Error("kaboom");
    });
    const s = await settled(lead("SAY x").id);
    expect(s.status).toBe("failed");
    expect(s.last_error).toContain("kaboom");
  });
});

describe("workspaces and symlinks", () => {
  test("a session started through a symlinked path is recorded at the real path, so it belongs to its workspace", async () => {
    const real = makeDir();
    const link = path.join(makeDir(), "link");
    fs.symlinkSync(real, link);
    const s = await settled(createLead({ prompt: "SAY hi", engine: "fake", cwd: link }).id);
    expect(s.base_cwd).toBe(fs.realpathSync(real));
  });
});
