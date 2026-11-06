import { describe, expect, test } from "bun:test";
import { changedLabel, commandsToText, durationLabel, forkState, fromTri, rewindState, stripView, textToCommands, tri, turnLines, verifyBusy, type CheckpointRow, type TurnBrief } from "../../web/src/features/checkpoints/logic";
import type { VerifyView } from "../../web/src/lib/types";

const turn = (seq: number, status = "completed"): TurnBrief => ({ id: `t${seq}`, seq, status, prompt: `p${seq}`, started_at: "", finished_at: null });
const cp = (kind: CheckpointRow["kind"], seq: number, changed = 1): CheckpointRow => ({ id: `${kind}${seq}`, kind, turn_id: kind === "turn" ? `t${seq}` : null, seq, ref: "r", commit: "c", changed, created_at: "" });
const verify = (over: Partial<VerifyView> = {}): VerifyView => ({ state: "passed", done: true, note: null, attempts: 0, last: { turn_id: "t1", state: "passed", finished_at: null, results: [{ name: "test", ok: true, exit: 0, duration_ms: 5 }] }, ...over });

describe("turn lines", () => {
  test("newest first; every turn can be rewound once a base exists; fork needs the turn's own checkpoint", () => {
    const lines = turnLines([turn(1), turn(2)], [cp("base", 0), cp("turn", 1, 3), cp("turn", 2, 0)]);
    expect(lines.map((l) => l.turn.seq)).toEqual([2, 1]);
    expect(lines.every((l) => l.canRewind && l.canFork)).toBe(true);
    expect(lines[1].changed).toBe(3);
  });

  test("a running turn can be neither rewound nor forked; no checkpoints means nothing to do", () => {
    const [running] = turnLines([turn(1, "running")], [cp("base", 0)]);
    expect(running.canRewind).toBe(false);
    expect(running.canFork).toBe(false);
    const [bare] = turnLines([turn(1)], []);
    expect(bare.canRewind).toBe(false);
    expect(bare.canFork).toBe(false);
  });

  test("labels", () => {
    expect(changedLabel(null)).toBe("");
    expect(changedLabel(0)).toBe("no file changes");
    expect(changedLabel(1)).toBe("1 file changed");
    expect(changedLabel(4)).toBe("4 files changed");
    expect(durationLabel(900)).toBe("900 ms");
    expect(durationLabel(2500)).toBe("2.5 s");
    expect(durationLabel(125_000)).toBe("2 m 5 s");
  });
});

describe("the verification strip", () => {
  test("says Done only when the session is done", () => {
    expect(stripView({ status: "idle", verify: verify(), done: true })).toMatchObject({ tone: "green", label: "Done: checks passed" });
    expect(stripView({ status: "running", verify: verify(), done: false })).toMatchObject({ tone: "neutral", label: "Checks passed" });
  });

  test("failing, running and fixing", () => {
    const failed = verify({ state: "failed", done: false, last: { turn_id: "t1", state: "failed", finished_at: null, results: [{ name: "typecheck", ok: false, exit: 2, duration_ms: 1 }, { name: "test", ok: true, exit: 0, duration_ms: 1 }] } });
    expect(stripView({ status: "idle", verify: failed, done: false })).toMatchObject({ tone: "red", label: "Checks failing: typecheck" });
    expect(stripView({ status: "idle", verify: verify({ state: "running", done: false }), done: false })?.label).toBe("Verifying…");
    expect(stripView({ status: "running", verify: verify({ state: "fixing", done: false }), done: false })?.tone).toBe("amber");
  });

  test("nothing to show when verification is off, found nothing, or never ran", () => {
    for (const state of ["off", "none", "unknown"] as const) expect(stripView({ status: "idle", verify: verify({ state, done: false }), done: false })).toBeNull();
    expect(stripView({ status: "idle", verify: null, done: false })).toBeNull();
    expect(verifyBusy("running")).toBe(true);
    expect(verifyBusy("failed")).toBe(false);
  });
});

describe("the commands text", () => {
  test("round trips name: command lines, and names a bare line by its position", () => {
    const cmds = [{ name: "typecheck", cmd: "bun run typecheck" }, { name: "test", cmd: "bun test" }];
    expect(textToCommands(commandsToText(cmds))).toEqual(cmds);
    expect(textToCommands("make check\n\n  lint: eslint .  ")).toEqual([{ name: "check 1", cmd: "make check" }, { name: "lint", cmd: "eslint ." }]);
    expect(commandsToText(null)).toBe("");
  });
});

describe("per-message actions", () => {
  const [line] = turnLines([turn(1)], [cp("base", 0), cp("turn", 1)]);
  const idle = { running: false, closed: false };

  test("rewind is on for an idle session with a checkpoint before the message", () => {
    expect(rewindState(line, idle)).toEqual({ enabled: true, label: "Rewind to before this message" });
  });

  test("rewind is off, with the reason, while running or closed, or without a checkpoint", () => {
    expect(rewindState(line, { running: true, closed: false })).toMatchObject({ enabled: false, label: expect.stringContaining("running") });
    expect(rewindState(line, { running: false, closed: true })).toMatchObject({ enabled: false, label: expect.stringContaining("closed") });
    expect(rewindState(undefined, idle).enabled).toBe(false);
    expect(rewindState({ ...line, canRewind: false }, idle).enabled).toBe(false);
  });

  test("fork needs the turn's own checkpoint, and is allowed on a closed or running session", () => {
    expect(forkState(line)).toEqual({ enabled: true, label: "Fork from here" });
    expect(forkState(undefined).enabled).toBe(false);
    const [running] = turnLines([turn(1, "running")], [cp("base", 0)]);
    expect(forkState(running).enabled).toBe(false);
  });

  test("scope config helpers round trip", () => {
    expect([tri(null), tri(true), tri(false)]).toEqual(["inherit", "on", "off"]);
    expect([fromTri("inherit"), fromTri("on"), fromTri("off")]).toEqual([null, true, false]);
  });
});
