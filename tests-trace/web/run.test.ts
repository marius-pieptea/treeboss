import { describe, expect, test } from "bun:test";
import { errorCount, formatIssuesForComposer, isLive, isPickMessage, loopbackPort, previewTarget, proxiedUrl, runRoot, statusLabel, type Instance } from "../../web/src/features/run/logic";

const inst = (o: Partial<Instance>): Instance => ({ key: "k", service: "dev", kind: "dev", command: "bun run dev", status: "running", pid: 1, port: 4100, url: "http://localhost:4100", exitCode: null, startedAt: 1, endedAt: null, owner: "w_1", ...o });

describe("run logic", () => {
  test("the panel works on the open session's working copy, else the workspace", () => {
    expect(runRoot("s_abc", "w_1")).toBe("s_abc");
    expect(runRoot(null, "w_1")).toBe("w_1");
    expect(runRoot("weird", "w_1")).toBe("w_1");
  });

  test("the preview follows a running server over a starting one, newest first", () => {
    expect(previewTarget([])).toBeNull();
    expect(previewTarget([inst({ key: "a", status: "starting", startedAt: 9 }), inst({ key: "b", status: "running", startedAt: 1 })])?.key).toBe("b");
    expect(previewTarget([inst({ key: "a", startedAt: 1 }), inst({ key: "b", startedAt: 5 })])?.key).toBe("b");
    expect(previewTarget([inst({ status: "stopped" }), inst({ kind: "task", url: null })])).toBeNull();
  });

  test("status words", () => {
    expect(statusLabel(undefined)).toBe("Not started");
    expect(statusLabel(inst({ status: "failed", exitCode: 7 }))).toBe("Failed (exit 7)");
    expect(isLive(inst({ status: "stopped" }))).toBe(false);
    expect(isLive(inst({ status: "starting" }))).toBe(true);
  });

  test("Inspect only applies to loopback http previews, and the proxy keeps the host name", () => {
    expect(loopbackPort("http://localhost:3000/x")).toBe(3000);
    expect(loopbackPort("http://127.0.0.1:5173")).toBe(5173);
    expect(loopbackPort("https://example.com")).toBeNull();
    expect(loopbackPort(null)).toBeNull();
    expect(proxiedUrl("http://localhost:3000/a?b=1", 5555)).toBe("http://localhost:5555/a?b=1");
  });

  test("only well-formed pick messages are forwarded", () => {
    expect(isPickMessage({ type: "trb-pick", selector: "#a" })).toBe(true);
    expect(isPickMessage({ type: "trb-pick", selector: "" })).toBe(false);
    expect(isPickMessage({ type: "other", selector: "#a" })).toBe(false);
    expect(isPickMessage("trb-pick")).toBe(false);
  });

  test("console errors become a compact block for the composer", () => {
    expect(formatIssuesForComposer(3000, [])).toBe("");
    const issues = [
      { ts: 1, level: "error" as const, text: "TypeError: x is   undefined", page: "/a" },
      { ts: 2, level: "warning" as const, text: "deprecated" },
    ];
    const t = formatIssuesForComposer(3000, issues);
    expect(t).toContain("localhost:3000");
    expect(t).toContain("- error /a: TypeError: x is undefined");
    expect(errorCount(issues)).toBe(1);
  });
});
