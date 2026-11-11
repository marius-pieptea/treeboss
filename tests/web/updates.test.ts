import { describe, expect, test } from "bun:test";
import { shouldNotify, updateChip, updateSummary, type UpdateState } from "../../web/src/lib/updates-logic";

const base: UpdateState = { status: "idle", version: "0.5.1", latest: null, percent: 0, message: "", checkedAt: null, selfInstall: true, enabled: true };

describe("update state", () => {
  test("the status bar speaks only when there is something to act on", () => {
    expect(updateChip(base)).toBeNull();
    expect(updateChip({ ...base, status: "current" })).toBeNull();
    expect(updateChip({ ...base, status: "ready", latest: "0.5.2" })).toBe("Restart to update to 0.5.2");
    expect(updateChip({ ...base, status: "downloading", percent: 40 })).toBe("Updating… 40%");
    expect(updateChip({ ...base, status: "ready", latest: "0.5.2", enabled: false })).toBeNull();
  });
  test("About explains each state", () => {
    expect(updateSummary({ ...base, status: "current" })).toBe("You are on the latest version.");
    expect(updateSummary({ ...base, enabled: false })).toBe("Update checks are off in this build.");
    expect(updateSummary({ ...base, status: "error", message: "Could not check for updates. Are you online?" })).toContain("online");
    expect(updateSummary({ ...base, status: "available", latest: "0.5.2", selfInstall: false })).toContain("by hand");
  });
  test("a toast shows once per version, not on every re-check", () => {
    const ready = { ...base, status: "ready" as const, latest: "0.5.2" };
    expect(shouldNotify(null, ready)).toBe(true);
    expect(shouldNotify(ready, { ...ready, checkedAt: 5 })).toBe(false);
    expect(shouldNotify(ready, { ...ready, latest: "0.5.3" })).toBe(true);
    expect(shouldNotify(null, { ...base, status: "current" })).toBe(false);
  });
});
