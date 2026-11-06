import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { attachAny, attachedLines, attachmentsBlock, detachAny, estimateSessionAny, kindOf, listAll } from "../src/attachments";
import { startServer } from "../src/daemon/server";
import { db } from "../src/db";
import type { TurnResult } from "../src/engines/runner";
import { handoff } from "../src/sessions/handoff";
import { createLead, getSession, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { setPlansDir } from "../src/sessions/plansdir";
import { listAttached as specRows } from "../src/specs/attach";
import { listAttached as docRows } from "../src/docs/attach";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState, settled } from "./helpers";

const TOKEN = "attachments-test-token";
const ok = (output: string): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" });

/** A repo with one spec feature, one plan and one docs page. */
function project() {
  return makeRepo({
    ".specify/memory/constitution.md": "# Constitution\n\n### I. Tests first\n",
    "specs/001-csv/spec.md": "# Feature: CSV export\n\n**Input**: add csv export\n",
    "specs/001-csv/tasks.md": "- [x] T001 a\n- [ ] T002 b\n",
    "plans/2026-10-08-csv.md": '---\ntitle: "CSV export plan"\nstatus: approved\n---\n\n# CSV export plan\n\nStep one.\n',
    "docs/architecture.md": "# Architecture\n\nThe daemon owns sessions.\n",
    "src/a.ts": "a\n",
  });
}

beforeEach(() => {
  resetState();
  specRows("-");
  docRows("-");
  db().exec("DELETE FROM session_specs; DELETE FROM session_docs");
  setTurnRunner(null);
});
afterEach(async () => {
  await interruptAll();
  setTurnRunner(null);
});

describe("which kind a path is", () => {
  test("by where it lives: specs, the plans folder (even renamed), everything else is a doc", () => {
    const dir = project();
    const s = { base_cwd: dir };
    expect(kindOf(s, "specs/001-csv")).toBe("spec");
    expect(kindOf(s, ".specify/memory/constitution.md")).toBe("spec");
    expect(kindOf(s, "plans/2026-10-08-csv.md")).toBe("plan");
    expect(kindOf(s, "docs/architecture.md")).toBe("doc");
    expect(kindOf(s, "docs/decisions/0001-x.md")).toBe("doc");
    const ws = Workspaces.open(dir);
    setPlansDir(ws.id, "thinking");
    expect(kindOf(s, "thinking/a.md")).toBe("plan");
    expect(kindOf(s, "plans/2026-10-08-csv.md")).toBe("doc");
  });
});

describe("one list, one block", () => {
  test("every kind attaches through the same call and lists together", () => {
    const dir = project();
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    attachAny(s.id, "specs/001-csv");
    attachAny(s.id, "plans/2026-10-08-csv.md", { mode: "inline" });
    attachAny(s.id, "docs/architecture.md");
    const all = listAll(s.id);
    expect(all.map((a) => [a.kind, a.path, a.mode])).toEqual([
      ["spec", "specs/001-csv", "ref"],
      ["plan", "plans/2026-10-08-csv.md", "inline"],
      ["doc", "docs/architecture.md", "ref"],
    ]);
    expect(specRows(s.id)).toHaveLength(2); // spec + plan share the specs table
    expect(docRows(s.id)).toHaveLength(1);
    expect(detachAny(s.id, "plans/2026-10-08-csv.md")).toBe(true);
    expect(detachAny(s.id, "nothing.md")).toBe(false);
    expect(listAll(s.id)).toHaveLength(2);
  });

  test("a bad path is refused with the owning module's message", () => {
    const dir = project();
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    expect(() => attachAny(s.id, "docs/missing.md")).toThrow(/does not exist/);
    expect(() => attachAny(s.id, "specs/../secrets.txt")).toThrow();
    expect(() => attachAny(s.id, "src/a.ts")).toThrow(/Only files under docs/);
  });

  test("the turn gets ONE block with a section per kind, once; changing the mode delivers it again", async () => {
    const dir = project();
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return ok("done");
    });
    const s = createLead({ prompt: "start", engine: "fake", cwd: dir, attachments: [{ path: "specs/001-csv" }, { path: "plans/2026-10-08-csv.md" }, { path: "docs/architecture.md" }] });
    await settled(s.id);
    const p = prompts[0];
    expect(p.match(/# Attached project files/g)).toHaveLength(1);
    expect(p).not.toContain("# Project specifications");
    expect(p).not.toContain("# Project documentation");
    for (const label of ["Specifications:", "Plans:", "Documentation:"]) expect(p).toContain(label);
    expect(p.indexOf("Specifications:")).toBeLessThan(p.indexOf("Plans:"));
    expect(p.indexOf("Plans:")).toBeLessThan(p.indexOf("Documentation:"));
    expect(p).toContain("`plans/2026-10-08-csv.md`: CSV export plan");
    expect(p).not.toContain("status: approved"); // front matter is not what a plan is about
    expect(p).toContain("The daemon owns sessions.");
    expect(listAll(s.id).every((a) => a.delivered)).toBe(true);
    expect(await attachmentsBlock(s.id)).toBeNull();
    attachAny(s.id, "docs/architecture.md", { mode: "inline" });
    const again = (await attachmentsBlock(s.id))!;
    expect(again).toContain("Pasted in full:");
    expect(again).toContain("# Architecture");
    expect(again).not.toContain("Specifications:");
  });

  test("a resumed turn carries only what is new, a fresh thread replays all", async () => {
    const dir = project();
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    await settled(s.id);
    attachAny(s.id, "specs/001-csv");
    const first = (await attachmentsBlock(s.id))!;
    expect(first).toContain("specs/001-csv");
    expect(first).not.toContain("Documentation:");
    expect(await attachmentsBlock(s.id, { all: true })).toContain("specs/001-csv");
  });

  test("the cost covers every kind", async () => {
    const dir = project();
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    attachAny(s.id, "specs/001-csv");
    attachAny(s.id, "plans/2026-10-08-csv.md");
    attachAny(s.id, "docs/architecture.md", { mode: "inline" });
    const e = await estimateSessionAny(s.id);
    expect(e.items.map((i) => i.kind)).toEqual(["spec", "plan", "doc"]);
    expect(e.items.every((i) => i.tokens > 0)).toBe(true);
    expect(e.tokens).toBe(e.items.reduce((n, i) => n + i.tokens, 0));
  });
});

describe("handoff", () => {
  test("names each kind once and carries every attachment to the new session", async () => {
    const dir = project();
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      return ok("summary text");
    });
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir, attachments: [{ path: "specs/001-csv" }, { path: "plans/2026-10-08-csv.md" }, { path: "docs/architecture.md" }] });
    await settled(s.id);
    expect(attachedLines(s.id).map((l) => l.split(" (")[0])).toEqual(["Attached specifications", "Attached plans", "Attached documentation"]);
    const h = await handoff(s.id, { method: "log" } as any);
    const next = getSession(h.session.id)!;
    expect(listAll(next.id).map((a) => a.path).sort()).toEqual(["docs/architecture.md", "plans/2026-10-08-csv.md", "specs/001-csv"]);
    await settled(next.id);
    expect(prompts.at(-1)).toContain("Attached plans");
  });
});

describe("over HTTP", () => {
  let server: ReturnType<typeof startServer>;
  const api = (method: string, p: string, body?: unknown) => fetch(`${server.url}${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  beforeAll(() => {
    server = startServer({ port: 0, token: TOKEN, onShutdown: () => {} });
  });
  afterAll(() => server.stop());

  test("attach, list, detach, with cost; and the workspace's candidates grouped", async () => {
    const dir = project();
    const ws = Workspaces.open(dir);
    const s = createLead({ prompt: "x", engine: "fake", cwd: dir });
    let r = await api("POST", `/api/sessions/${s.id}/attachments`, { path: "plans/2026-10-08-csv.md", mode: "inline" });
    expect(r.status).toBe(201);
    expect((await r.json()).attached).toMatchObject({ kind: "plan", mode: "inline" });
    await api("POST", `/api/sessions/${s.id}/attachments`, { path: "docs/architecture.md" });
    const list = await (await api("GET", `/api/sessions/${s.id}/attachments`)).json();
    expect(list.attached).toHaveLength(2);
    expect(list.estimate.tokens).toBeGreaterThan(0);
    r = await api("DELETE", `/api/sessions/${s.id}/attachments?path=docs/architecture.md`);
    expect((await r.json()).removed).toBe(true);
    r = await api("POST", `/api/sessions/${s.id}/attachments`, { path: "docs/missing.md" });
    expect(r.status).toBe(400);

    const c = await (await api("GET", `/api/attachments/${ws.id}/candidates?fast=1`)).json();
    expect(c.specs.map((x: any) => x.path)).toEqual([".specify/memory/constitution.md", "specs/001-csv"]);
    expect(c.plans).toEqual([{ path: "plans/2026-10-08-csv.md", title: "CSV export plan", sub: "approved" }]);
    expect(c.docs.map((x: any) => x.path)).toEqual(["docs/architecture.md"]);
    const est = await (await api("GET", `/api/attachments/${ws.id}/estimate?path=plans/2026-10-08-csv.md&mode=ref`)).json();
    expect(est).toMatchObject({ kind: "plan", truncated: false });
  });

  test("a session can be created with attachments of every kind", async () => {
    const dir = project();
    const r = await api("POST", "/api/sessions", { prompt: "x", engine: "fake", cwd: dir, attachments: [{ path: "specs/001-csv" }, { path: "docs/architecture.md", mode: "inline" }] });
    expect(r.status).toBe(201);
    const id = (await r.json()).session.id;
    expect(listAll(id).map((a) => [a.kind, a.mode])).toEqual([["spec", "ref"], ["doc", "inline"]]);
  });
});
