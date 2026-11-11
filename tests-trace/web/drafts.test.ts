import { describe, expect, test } from "bun:test";
import { MAX_DRAFTS, commitDraftKey, createDraftStore, draftCounts, draftKey, draftedSessions, parseDrafts, withDraft, withoutSession } from "../../web/src/lib/drafts";

const mem = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("draft keys", () => {
  test("the empty session is per workspace, so a draft never crosses workspaces", () => {
    expect(draftKey("w_a", null)).not.toBe(draftKey("w_b", null));
    expect(draftKey("w_a", "s_1")).toBe("w_a:s_1");
  });
});

describe("commit message keys", () => {
  test("are per git root and never collide with an agent draft", () => {
    expect(commitDraftKey("w_a")).not.toBe(commitDraftKey("s_1"));
    expect(commitDraftKey("w_a")).not.toBe(draftKey("w_a", null));
    // Deleting a session also forgets the message of its worktree.
    const d = withDraft(withDraft({}, commitDraftKey("s_1"), "fix x", 1), commitDraftKey("w_a"), "keep", 2);
    expect(Object.keys(withoutSession(d, "s_1"))).toEqual([commitDraftKey("w_a")]);
  });
});

describe("withDraft", () => {
  test("sets, replaces and removes on blank without touching the input", () => {
    const a = withDraft({}, "k", "hello", 1);
    expect(a.k).toEqual({ text: "hello", at: 1 });
    expect(withDraft(a, "k", "  \n", 2)).toEqual({});
    expect(a.k.text).toBe("hello");
  });
  test("keeps the newest MAX_DRAFTS", () => {
    let d = {};
    for (let i = 0; i < MAX_DRAFTS + 5; i++) d = withDraft(d, `k${i}`, "x", i);
    expect(Object.keys(d)).toHaveLength(MAX_DRAFTS);
    expect("k0" in d).toBe(false);
    expect(`k${MAX_DRAFTS + 4}` in d).toBe(true);
  });
});

describe("withoutSession", () => {
  test("drops a session in every workspace, keeps the rest", () => {
    const d = withDraft(withDraft(withDraft({}, "w_a:s_1", "a", 1), "w_b:s_1", "b", 2), "w_a:new", "c", 3);
    expect(Object.keys(withoutSession(d, "s_1"))).toEqual(["w_a:new"]);
  });
});

describe("parseDrafts", () => {
  test("corrupt or foreign values read as empty; bad entries are skipped", () => {
    expect(parseDrafts("{nope")).toEqual({});
    expect(parseDrafts("[]")).toEqual({});
    expect(parseDrafts(null)).toEqual({});
    expect(parseDrafts(JSON.stringify({ ok: { text: "t", at: 1 }, bad: { text: 3 }, blank: { text: " ", at: 1 } }))).toEqual({ ok: { text: "t", at: 1 } });
  });
});

describe("createDraftStore", () => {
  test("a draft written and flushed is read back by a new store (a reload)", () => {
    const s = mem();
    const a = createDraftStore(s, () => 5);
    a.set("w:new", "half a thought");
    expect(a.get("w:new")).toBe("half a thought");
    a.flush();
    expect(createDraftStore(s).get("w:new")).toBe("half a thought");
  });
  test("sending (blank) removes the draft from storage", () => {
    const s = mem();
    const a = createDraftStore(s);
    a.set("k", "x");
    a.flush();
    a.set("k", "");
    a.flush();
    expect(parseDrafts(s.m.get("trb.agent.drafts"))).toEqual({});
  });
  test("a store with no storage still works in memory", () => {
    const a = createDraftStore(null);
    a.set("k", "x");
    expect(a.get("k")).toBe("x");
    expect(a.get("other")).toBe("");
  });
});

describe("where the drafts are", () => {
  const d = (text = "x") => ({ text, at: 1 });
  const all = {
    [draftKey("w_a", "s_1")]: d(),
    [draftKey("w_a", "s_2")]: d(),
    [draftKey("w_a", null)]: d(),
    [draftKey("w_b", "s_3")]: d(),
    [commitDraftKey("w_a")]: d(),
    [commitDraftKey("s_4")]: d(),
    [draftKey(null, "s_5")]: d(),
  };
  test("each workspace counts its sessions' drafts and its new one, never commit messages", () => {
    expect(draftCounts(all)).toEqual({ w_a: 3, w_b: 1 });
  });
  test("drafted sessions are the session ids with an agent draft, in any workspace", () => {
    expect(draftedSessions(all)).toEqual(["s_1", "s_2", "s_3", "s_5"]);
  });
});

describe("subscribing to the store", () => {
  test("a change notifies, a no-op does not, and the snapshot changes only when a draft does", () => {
    const a = createDraftStore(null);
    let calls = 0;
    const off = a.subscribe(() => calls++);
    const before = a.all();
    a.set("w_a:s_1", "hi");
    expect(calls).toBe(1);
    const after = a.all();
    expect(after).not.toBe(before);
    a.set("w_a:s_1", "hi");
    a.set("w_a:s_9", "");
    expect(calls).toBe(1);
    expect(a.all()).toBe(after);
    a.dropSession("s_1");
    expect(calls).toBe(2);
    expect(draftedSessions(a.all())).toEqual([]);
    off();
    a.set("w_a:s_1", "again");
    expect(calls).toBe(2);
  });
});
