import { describe, expect, test } from "bun:test";
import { ago, countdown, grantsLabel, modeBlocked, MODES, modelLabel, nearBottom, pairingShowable, secondsLeft, sendState, sessionFromHash, sortLeads, statusChip, windowItems } from "../../web/src/remote/logic";

const s = (over: any = {}) => ({ id: "s_1", title: "t", status: "idle", depth: 0, mode: "build", engine: "claude", model: "claude-opus-4", effort: null, ...over });

describe("remote view logic", () => {
  test("status chip: the most specific thing first", () => {
    expect(statusChip(s({ status: "failed" })).label).toBe("Failed");
    expect(statusChip(s({ status: "closed" })).label).toBe("Closed");
    expect(statusChip(s({ mode: "plan" }), { pending: true, draft: false })).toEqual({ label: "Needs your answer", tone: "amber" });
    expect(statusChip(s({ mode: "plan" }), { pending: false, draft: true }).label).toBe("Plan ready");
    // A draft is not decidable while the turn is still running.
    expect(statusChip(s({ mode: "plan", status: "running" }), { pending: false, draft: true }).label).toBe("Working");
    expect(statusChip(s({ status: "running", waiting_on: [{ id: "a", name: "a" }, { id: "b", name: "b" }] })).label).toBe("Waiting on 2 heads");
    expect(statusChip(s({ mode: "plan" })).label).toBe("Planning");
    expect(statusChip(s()).label).toBe("Idle");
  });

  test("leads only, working first, stable otherwise", () => {
    const list = [s({ id: "a" }), s({ id: "h", depth: 1 }), s({ id: "b", status: "running" }), s({ id: "c", status: "failed" }), s({ id: "d", status: "closed" }), s({ id: "e" })];
    expect(sortLeads(list as any).map((x) => x.id)).toEqual(["b", "c", "a", "e", "d"]);
  });

  test("a follow-up needs an idle session and some text", () => {
    expect(sendState("idle", "  ")).toEqual({ canSend: false, hint: null });
    expect(sendState("idle", "go")).toEqual({ canSend: true, hint: null });
    expect(sendState("failed", "go").canSend).toBe(true);
    expect(sendState("running", "go").canSend).toBe(false);
    expect(sendState("running", "go").hint).toContain("Interrupt");
    expect(sendState("closed", "go").canSend).toBe(false);
  });

  test("windowing and scroll pinning", () => {
    expect(windowItems([1, 2, 3, 4, 5], 3)).toEqual({ items: [3, 4, 5], hidden: 2 });
    expect(windowItems([1, 2], 5)).toEqual({ items: [1, 2], hidden: 0 });
    expect(nearBottom({ scrollTop: 880, clientHeight: 100, scrollHeight: 1000 })).toBe(true);
    expect(nearBottom({ scrollTop: 100, clientHeight: 100, scrollHeight: 1000 })).toBe(false);
  });

  test("hash routing only accepts session ids", () => {
    expect(sessionFromHash("#s_0123456789")).toBe("s_0123456789");
    expect(sessionFromHash("#/s_0123456789")).toBe("s_0123456789");
    expect(sessionFromHash("#s_x")).toBeNull();
    expect(sessionFromHash("#javascript:alert(1)")).toBeNull();
    expect(sessionFromHash("")).toBeNull();
  });

  test("labels", () => {
    expect(modelLabel({ engine: "claude", model: "anthropic/claude-opus", effort: "high" })).toBe("claude · claude-opus · @high");
    expect(grantsLabel({ terminal: false, files: "off" })).toBe("sessions, plans, follow-ups");
    expect(grantsLabel({ terminal: true, files: "write" })).toContain("terminals");
    expect(grantsLabel({ terminal: false, files: "read" })).toContain("files (read)");
    const now = Date.parse("2026-10-08T12:00:00Z");
    expect(ago("2026-10-08T11:59:50Z", now)).toBe("now");
    expect(ago("2026-10-08T11:30:00Z", now)).toBe("30m");
    expect(ago("2026-10-08T06:00:00Z", now)).toBe("6h");
    expect(ago("2026-10-06 12:00:00", now)).toBe("2d");
    expect(secondsLeft("2026-10-08T12:02:00Z", now)).toBe(120);
    expect(secondsLeft("2026-10-08T11:00:00Z", now)).toBe(0);
    expect(countdown(125)).toBe("2:05");
  });
});

describe("pairing links and modes", () => {
  test("a link to this computer is never showable", () => {
    for (const u of ["http://127.0.0.1:4477/_pair?code=x", "http://localhost:4477/_pair", "http://[::1]:4477/", "http://0.0.0.0:1/", "http://127.1.2.3/", "not a url", ""]) expect(pairingShowable(u)).toBe(false);
    for (const u of ["http://192.168.1.20:4477/_pair?code=x", "http://mac.tail1234.ts.net:4477/_pair", "http://100.101.102.103:4477/"]) expect(pairingShowable(u)).toBe(true);
  });
  test("a mode is blocked with the reason", () => {
    const d = { lan: null, tailscale: { state: "not-installed", message: "Tailscale is not installed." } };
    expect(modeBlocked("off", d)).toBeNull();
    expect(modeBlocked("lan", d)).toContain("No local network");
    expect(modeBlocked("tailscale", d)).toBe("Tailscale is not installed.");
    expect(modeBlocked("lan", { ...d, lan: { ip: "192.168.1.2" } })).toBeNull();
    expect(modeBlocked("tailscale", { ...d, tailscale: { state: "ok", message: "" } })).toBeNull();
    expect(MODES.map((m) => m.id)).toEqual(["off", "lan", "tailscale"]);
  });
});
