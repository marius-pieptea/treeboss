import { describe, expect, test } from "bun:test";
import { busyKind, drainsOn, edit, enqueue, forSession, move, preview, putBack, remove, takeHead, type QueuedMessage } from "../../web/src/features/agent/queue-logic";

const m = (id: string, sessionId = "s1", text = id): QueuedMessage => ({ id, sessionId, text });

describe("queue", () => {
  test("keeps order and is per session", () => {
    const q = [m("a"), m("b", "s2"), m("c")].reduce(enqueue, [] as QueuedMessage[]);
    expect(forSession(q, "s1").map((x) => x.id)).toEqual(["a", "c"]);
    expect(forSession(q, null)).toEqual([]);
  });

  test("takeHead pops the first of that session only", () => {
    const q = [m("a", "s2"), m("b"), m("c")];
    const { head, rest } = takeHead(q, "s1");
    expect(head?.id).toBe("b");
    expect(rest.map((x) => x.id)).toEqual(["a", "c"]);
    expect(takeHead(q, "none").head).toBeNull();
  });

  test("putBack returns a failed message to the front of its session", () => {
    const q = putBack([m("a", "s2"), m("c")], m("b"));
    expect(q.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(putBack([], m("z")).map((x) => x.id)).toEqual(["z"]);
  });

  test("move swaps within a session and leaves other sessions' slots alone", () => {
    const q = [m("a"), m("x", "s2"), m("b"), m("c")];
    expect(move(q, "b", -1).map((x) => x.id)).toEqual(["b", "x", "a", "c"]);
    expect(move(q, "a", -1)).toBe(q);
    expect(move(q, "c", 1)).toBe(q);
    expect(move(q, "nope", 1)).toBe(q);
  });

  test("edit trims, and an empty edit changes nothing", () => {
    const q = [m("a")];
    expect(edit(q, "a", "  new text \n")[0].text).toBe("new text");
    expect(edit(q, "a", "   ")).toBe(q);
  });

  test("remove drops one message", () => {
    expect(remove([m("a"), m("b")], "a").map((x) => x.id)).toEqual(["b"]);
  });

  test("only a lead's completed turn drains", () => {
    expect(drainsOn({ sessionId: "s1", rootId: "s1", status: "completed" })).toBe(true);
    expect(drainsOn({ sessionId: "s1", rootId: "s1", status: "cancelled" })).toBe(false);
    expect(drainsOn({ sessionId: "s1", rootId: "s1", status: "failed" })).toBe(false);
    expect(drainsOn({ sessionId: "h1", rootId: "s1", status: "completed" })).toBe(false);
  });

  test("preview shows the first non-empty line, clipped", () => {
    expect(preview("\n  hello\nworld")).toBe("hello");
    expect(preview("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });

  test("busyKind tells a timing refusal (worth asking again) from a real failure", () => {
    expect(busyKind("Session s_1 is still working. Wait for it, or interrupt it first.")).toBe("working");
    expect(busyKind("Session s_1 is still finishing its last turn. Try again in a moment.")).toBe("finishing");
    expect(busyKind("Session s_1 is closed. Open a new one.")).toBeNull();
    expect(busyKind("Network error")).toBeNull();
  });
});
