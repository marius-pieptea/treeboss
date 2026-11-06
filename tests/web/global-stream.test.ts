import { describe, expect, test } from "bun:test";
import { applyGlobalEvents, queryClient, qk } from "../../web/src/lib/queries";
import type { LiveSource } from "../../web/src/lib/live";

/** A LiveSource we fire by hand, with the MessageEvent shape the real one passes. */
function fakeSource() {
  const listeners = new Map<string, Array<(e: any) => void>>();
  const source: LiveSource = {
    addEventListener(type, l) {
      listeners.set(type, [...(listeners.get(type) ?? []), l]);
    },
    close() {},
    onerror: null,
  };
  const fire = (type: string, data: unknown, lastEventId = "") => {
    for (const l of listeners.get(type) ?? []) l({ data: JSON.stringify(data), lastEventId });
  };
  return { source, fire };
}

/** A query client that records each invalidation instead of refetching anything. */
function recordingClient() {
  const calls: Array<readonly unknown[] | undefined> = [];
  // Shadow the one method on a derived object, so the app's shared client is left as it was.
  const qc = Object.assign(Object.create(queryClient), {
    invalidateQueries: (filters?: { queryKey?: readonly unknown[] }) => {
      calls.push(filters?.queryKey);
      return Promise.resolve();
    },
  }) as typeof queryClient;
  return { qc, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("applying the global stream", () => {
  test("a state event invalidates only that session's views, and the lists once after a burst", async () => {
    const { qc, calls } = recordingClient();
    const { source, fire } = fakeSource();
    applyGlobalEvents(source, qc);
    fire("state", { sessionId: "s_child", rootId: "s_root", status: "idle" });
    fire("state", { sessionId: "s_child2", rootId: "s_root", status: "idle" });
    expect(calls).toEqual([qk.session("s_root"), qk.session("s_child"), qk.session("s_root"), qk.session("s_child2")]);
    await sleep(170);
    expect(calls.slice(4)).toEqual([qk.sessionsAll, qk.workspaceActivity]);
  });

  test("a turn_end also marks git, files and specs stale; a turn_start only touches the lists", async () => {
    const { qc, calls } = recordingClient();
    const { source, fire } = fakeSource();
    applyGlobalEvents(source, qc);
    fire("turn_start", { sessionId: "s_a", rootId: "s_a", turnId: "t" });
    expect(calls).toEqual([]);
    fire("turn_end", { sessionId: "s_a", rootId: "s_a", turnId: "t", status: "done" });
    expect(calls).toEqual([qk.session("s_a"), qk.session("s_a"), ["specs"], ["git"], ["fs"]]);
  });

  test("reset invalidates everything", () => {
    const { qc, calls } = recordingClient();
    const { source, fire } = fakeSource();
    applyGlobalEvents(source, qc);
    fire("reset", { t: 1 }, "1800000000000001");
    expect(calls).toEqual([undefined]);
  });

  test("each event with an id moves the cursor on, so the caller can resume after it", () => {
    const { qc } = recordingClient();
    const { source, fire } = fakeSource();
    const seen: string[] = [];
    applyGlobalEvents(source, qc, (id) => seen.push(id));
    fire("state", { sessionId: "s_a", rootId: "s_a", status: "idle" }, "41");
    fire("turn_end", { sessionId: "s_a", rootId: "s_a", turnId: "t", status: "done" }, "42");
    fire("turn_start", { sessionId: "s_a", rootId: "s_a", turnId: "t" });
    expect(seen).toEqual(["41", "42"]);
  });
});
