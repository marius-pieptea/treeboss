/** The device owner and the agent tools, on a fake adb and a fake installer: no real emulator, no network. */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EMULATOR_TOOL_NAMES, emulatorToolDefs } from "../src/emulator/defs";
import { createEmulator, setEmulator, type Emulator, type EmulatorOptions } from "../src/emulator/emulator";
import { executeEmulatorTool } from "../src/emulator/tools";
import type { SdkState } from "../src/emulator/types";
import { setSetting } from "../src/settings";
import { AVD, PLAN, fakeDeps, fakeInstaller, fakeLive, png, type FakeDevice, type FakeInstaller } from "./emulator-fakes";

const INSTALLED: SdkState = { kind: "installed", root: "/sdk", owned: true, avd: AVD };
const you = { kind: "you" } as const;
const agent = (id = "s_1") => ({ kind: "agent", sessionId: id }) as const;

let auditFile: string;
let emus: Emulator[] = [];
beforeEach(() => {
  auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trb-emu-")), "audit.log");
});
afterEach(async () => {
  setEmulator(null);
  for (const e of emus) await e.shutdown();
  emus = [];
});

const instant = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2)));
function make(disk: SdkState = INSTALLED, o: EmulatorOptions = {}): { emu: Emulator; dev: FakeDevice; installer: FakeInstaller } {
  const { deps, dev } = fakeDeps();
  const installer = fakeInstaller(disk);
  const emu = createEmulator(deps, installer, { sleep: instant, frameMs: 5, bootPollMs: 1, auditFile: () => auditFile, ...o });
  emus.push(emu);
  return { emu, dev, installer };
}
async function running(o: EmulatorOptions = {}) {
  const m = make(INSTALLED, o);
  m.dev.avd = "trb"; // an emulator is already up, so refresh adopts it
  await m.emu.refresh();
  expect(m.emu.snapshot().device.kind).toBe("running");
  return m;
}
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe("boot and adoption", () => {
  test("a running emulator of the trb AVD is adopted; someone else's is not", async () => {
    const { emu } = await running();
    expect(emu.snapshot().device).toMatchObject({ kind: "running", serial: "emulator-5554", screen: { width: 720, height: 1600 } });

    const other = make();
    other.dev.avd = "Pixel_6";
    await other.emu.refresh();
    expect(other.emu.snapshot().device.kind).toBe("stopped");
  });

  test("boot spawns the emulator headless with the SDK and AVD folders, and waits for boot_completed", async () => {
    const { emu, dev } = make();
    await emu.refresh();
    const r = await emu.run(agent(), { kind: "boot" });
    expect(r).toMatchObject({ ok: true });
    expect(emu.snapshot().device).toMatchObject({ kind: "running", screen: { width: 720, height: 1600 } });
    const s = dev.spawned[0]!;
    expect(s.argv).toEqual(["/sdk/emulator/emulator", "-avd", "trb", "-port", "5554", "-grpc", "8554", "-grpc-use-token", "-no-window", "-no-audio", "-no-boot-anim", "-gpu", "swiftshader_indirect"]);
    expect(s.env).toMatchObject({ ANDROID_AVD_HOME: "/avd", ANDROID_SDK_ROOT: "/sdk" });
    expect(dev.calls.filter((c) => c.join(" ").includes("sys.boot_completed")).length).toBeGreaterThan(1);
    expect((await emu.run(you, { kind: "boot" })).ok).toBe(true);
    expect(dev.spawned.length).toBe(1); // a second boot does not start a second emulator
  });

  test("an emulator that exits while booting is a failed device with the reason", async () => {
    const { emu, dev } = make(INSTALLED, { bootPollMs: 5 });
    dev.bootPolls = 1_000_000;
    await emu.refresh();
    const booting = emu.run(you, { kind: "boot" });
    await until(() => dev.spawned.length > 0);
    dev.spawned[0]!.exit(1);
    const r = await booting;
    expect(r.ok).toBe(false);
    expect(emu.snapshot().device).toMatchObject({ kind: "failed" });
  });

  test("shutdown by the operator asks the emulator to exit; an agent's shutdown is refused", async () => {
    const { emu, dev } = await running();
    const refused = await emu.run(agent(), { kind: "shutdown" });
    expect(refused).toMatchObject({ ok: false });
    expect(emu.snapshot().device.kind).toBe("running");
    expect(dev.calls.some((c) => c[0] === "emu" && c[1] === "kill")).toBe(false);

    expect(await emu.run(you, { kind: "shutdown" })).toMatchObject({ ok: true });
    expect(emu.snapshot().device.kind).toBe("stopped");
    expect(dev.calls.some((c) => c[0] === "emu" && c[1] === "kill")).toBe(true);
  });
});

describe("actions", () => {
  test("actions from two actors run one at a time, in the order they were asked", async () => {
    const { emu, dev } = await running();
    let open!: () => void;
    dev.gates.set("input tap", new Promise<void>((r) => (open = r)));
    const first = emu.run(agent("s_a"), { kind: "input", input: { kind: "tap", x: 10, y: 20 } });
    const second = emu.run(you, { kind: "input", input: { kind: "key", key: "back" } });
    await until(() => dev.calls.some((c) => c.join(" ").includes("input tap")));
    await new Promise((r) => setTimeout(r, 30));
    expect(dev.calls.some((c) => c.join(" ").includes("keyevent"))).toBe(false); // the second waits for the first
    open();
    await Promise.all([first, second]);
    const order = dev.calls.map((c) => c.join(" ")).filter((l) => /input (tap|keyevent)/.test(l));
    expect(order).toEqual(["shell input tap 10 20", "shell input keyevent KEYCODE_BACK"]);
    expect(emu.snapshot().lastActor?.actor).toEqual(you);
  });

  test("a long job does not hold up the operator's taps, and is tracked in the view", async () => {
    const { emu, dev } = await running();
    const apk = path.join(path.dirname(auditFile), "app.apk");
    fs.writeFileSync(apk, "x");
    let open!: () => void;
    dev.gates.set("install -r", new Promise<void>((r) => (open = r)));
    const install = emu.run(agent(), { kind: "install_apk", path: apk });
    await until(() => emu.snapshot().jobs.length === 1);
    expect(emu.snapshot().jobs[0]).toMatchObject({ kind: "install_apk", state: "running", actor: agent() });
    expect(await emu.run(you, { kind: "input", input: { kind: "tap", x: 1, y: 1 } })).toMatchObject({ ok: true });
    open();
    expect(await install).toMatchObject({ ok: true });
    expect(emu.snapshot().jobs[0]!.state).toBe("done");
  });

  test("typed text is audited by its length only", async () => {
    const { emu } = await running();
    await emu.run(agent("s_z"), { kind: "input", input: { kind: "text", text: "hunter2 secret" } });
    const log = fs.readFileSync(auditFile, "utf8");
    expect(log).toContain("14 characters");
    expect(log).toContain("agent:s_z");
    expect(log).not.toContain("hunter2");
  });

  test("a bad request comes back as an error result, never a throw", async () => {
    const { emu } = await running();
    expect(await emu.run(you, { kind: "input", input: { kind: "text", text: "héllo" } })).toMatchObject({ ok: false });
    expect(await emu.run(you, { kind: "open_url", url: "file:///etc/passwd" })).toMatchObject({ ok: false });
    expect(await emu.run(you, { kind: "open_url", url: "no-scheme" })).toMatchObject({ ok: false });
    expect(await emu.run(you, { kind: "launch", pkg: "x; rm -rf /" })).toMatchObject({ ok: false });
    expect(await emu.run(you, { kind: "install_apk", path: "/nope.apk" })).toMatchObject({ ok: false });
  });

  test("an input is followed at once by a frame, and identical frames do not bump seq", async () => {
    const { emu, dev } = await running();
    const seq = () => (emu.snapshot().device.kind === "running" ? (emu.snapshot().device as { seq: number }).seq : -1);
    expect(seq()).toBe(0);
    await emu.run(you, { kind: "input", input: { kind: "tap", x: 1, y: 1 } });
    expect(seq()).toBe(1);
    expect(emu.frame()?.seq).toBe(1);
    await emu.run(you, { kind: "input", input: { kind: "tap", x: 1, y: 1 } }); // the screen did not change
    expect(seq()).toBe(1);
    dev.screen = { tag: "b", width: 720, height: 1600 };
    await emu.run(you, { kind: "input", input: { kind: "tap", x: 1, y: 1 } });
    expect(seq()).toBe(2);
    expect(Buffer.from(emu.frame()!.bytes).equals(Buffer.from(png(720, 1600, "b")))).toBe(true);
  });
});

describe("live channel", () => {
  const shots = (dev: FakeDevice) => dev.calls.filter((c) => c[0] === "exec-out" && c[1] === "screencap").length;
  const device = (emu: Emulator) => emu.snapshot().device as { seq: number; live: boolean; rotation: number };
  async function live() {
    const l = fakeLive();
    const m = await running({ openLive: async () => l.ch });
    await until(() => device(m.emu).live);
    return { ...m, l };
  }

  test("a watched device streams its frames instead of polling; an agent's screenshot still comes from adb", async () => {
    const { emu, dev, l } = await live();
    const before = shots(dev);
    const stop = emu.watch(() => {});
    await until(() => l.log.includes("stream"));
    l.frame("one");
    l.frame("one"); // the same picture again
    expect(device(emu).seq).toBe(1);
    l.frame("two");
    expect(device(emu).seq).toBe(2);
    expect(Buffer.from(emu.frame()!.bytes).equals(Buffer.from(png(720, 1600, "two")))).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(shots(dev)).toBe(before); // nothing polled while streaming

    const shot = await emu.capture(agent());
    expect(shot.ok && Buffer.from(shot.frame.bytes).equals(Buffer.from(png(720, 1600, "a")))).toBe(true);
    expect(device(emu).seq).toBe(2); // the view keeps the stream's picture
    stop();
    expect(l.log).toContain("stream stopped");
  });

  test("the operator's keys and text take the channel, newlines as Enter; an agent's keys keep adb", async () => {
    const { emu, dev, l } = await live();
    expect(await emu.run(you, { kind: "input", input: { kind: "key", key: "back" } })).toMatchObject({ ok: true });
    expect(await emu.run(you, { kind: "input", input: { kind: "text", text: "hi\nthere %s" } })).toMatchObject({ ok: true });
    expect(l.log.filter((x) => /^(key|text) /.test(x))).toEqual(["key back", "text hi", "key enter", "text there %s"]);
    expect(dev.calls.some((c) => c.join(" ").includes("input keyevent"))).toBe(false);
    expect(await emu.run(you, { kind: "input", input: { kind: "text", text: "héllo" } })).toMatchObject({ ok: false });
    await emu.run(agent(), { kind: "input", input: { kind: "key", key: "home" } });
    expect(dev.calls.some((c) => c.join(" ") === "shell input keyevent KEYCODE_HOME")).toBe(true);
  });

  test("a press holds the queue until its release: an agent's tap waits for the whole gesture, which is recorded once", async () => {
    const { emu, dev, l } = await live();
    expect(await emu.pointer(you, { x: 10, y: 20, down: true })).toMatchObject({ ok: true });
    const tap = emu.run(agent(), { kind: "input", input: { kind: "tap", x: 5, y: 5 } });
    expect(await emu.pointer(you, { x: 15.4, y: 30, down: true })).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(dev.calls.some((c) => c.join(" ").includes("input tap"))).toBe(false);
    expect(await emu.pointer(you, { x: 9999, y: -4, down: false })).toMatchObject({ ok: true }); // past the edge: held to it
    await tap;
    expect(l.log.filter((x) => x.startsWith("touch"))).toEqual(["touch 10,20 down", "touch 15,30 down", "touch 719,0 up"]);
    expect(dev.calls.some((c) => c.join(" ") === "shell input tap 5 5")).toBe(true);
    expect(fs.readFileSync(auditFile, "utf8").match(/touch \(/g)).toHaveLength(1);
    expect(await emu.pointer(you, { x: 1, y: 1, down: false })).toMatchObject({ ok: true }); // a release with nothing pressed lifts nothing
    expect(l.log.filter((x) => x.startsWith("touch"))).toHaveLength(3);
  });

  test("the last viewer leaving lifts a finger still down and lets the queue go", async () => {
    const { emu, dev, l } = await live();
    const stop = emu.watch(() => {});
    await emu.pointer(you, { x: 10, y: 20, down: true });
    const tap = emu.run(agent(), { kind: "input", input: { kind: "tap", x: 5, y: 5 } });
    stop();
    await tap;
    expect(l.log.filter((x) => x.startsWith("touch"))).toEqual(["touch 10,20 down", "touch 10,20 up"]);
    expect(dev.calls.some((c) => c.join(" ") === "shell input tap 5 5")).toBe(true);
  });

  test("rotated, the view goes back to adb and the poller; back in portrait, live again", async () => {
    const { emu, dev, l } = await live();
    const stop = emu.watch(() => {});
    await until(() => l.log.includes("stream"));
    dev.rotation = 1;
    await emu.run(you, { kind: "input", input: { kind: "rotate", to: "landscape" } });
    expect(device(emu)).toMatchObject({ rotation: 1, live: false });
    expect(l.log).toContain("stream stopped");
    expect(await emu.pointer(you, { x: 1, y: 1, down: true })).toMatchObject({ ok: false });
    await emu.run(you, { kind: "input", input: { kind: "key", key: "back" } });
    expect(dev.calls.some((c) => c.join(" ") === "shell input keyevent KEYCODE_BACK")).toBe(true);
    const before = shots(dev);
    await until(() => shots(dev) > before + 1); // polling
    dev.rotation = 0;
    await emu.run(you, { kind: "input", input: { kind: "rotate", to: "portrait" } });
    expect(device(emu).live).toBe(true);
    expect(l.log.filter((x) => x === "stream")).toHaveLength(2);
    stop();
  });

  test("when the stream ends by itself the channel is dropped and the poller takes over", async () => {
    const { emu, dev, l } = await live();
    const stop = emu.watch(() => {});
    await until(() => l.log.includes("stream"));
    const before = shots(dev);
    l.end();
    expect(device(emu).live).toBe(false);
    expect(l.log).toContain("close");
    await until(() => shots(dev) > before);
    stop();
  });

  test("without a channel (an emulator started without -grpc) the finger is refused and everything is adb", async () => {
    const { emu } = await running({ openLive: async () => null });
    expect(device(emu).live).toBe(false);
    expect(await emu.pointer(you, { x: 1, y: 1, down: true })).toMatchObject({ ok: false, error: expect.stringContaining("gRPC") });
  });
});

describe("frame poller and idle", () => {
  test("the poller runs only while someone watches, and dedupes unchanged frames", async () => {
    const { emu, dev } = await running();
    const shots = () => dev.calls.filter((c) => c[0] === "exec-out" && c[1] === "screencap").length;
    const before = shots();
    await new Promise((r) => setTimeout(r, 40));
    expect(shots()).toBe(before); // nobody is watching

    const stop = emu.watch(() => {});
    await until(() => shots() >= before + 4);
    expect(emu.snapshot().device).toMatchObject({ seq: 1 }); // four polls of the same screen: one new frame
    dev.screen = { tag: "changed", width: 720, height: 1600 };
    await until(() => (emu.snapshot().device as { seq: number }).seq === 2);
    stop();
    await new Promise((r) => setTimeout(r, 20));
    const after = shots();
    await new Promise((r) => setTimeout(r, 40));
    expect(shots()).toBe(after); // stopped polling
  });

  test("it shuts itself down when idle, but not while someone is watching", async () => {
    const watched = await running({ idleMs: 30, idleCheckMs: 5 });
    const stop = watched.emu.watch(() => {});
    await new Promise((r) => setTimeout(r, 120));
    expect(watched.emu.snapshot().device.kind).toBe("running");
    stop();
    await until(() => watched.emu.snapshot().device.kind === "stopped");
    expect(watched.dev.calls.some((c) => c[0] === "emu" && c[1] === "kill")).toBe(true);
    expect(fs.readFileSync(auditFile, "utf8")).toContain("idle shutdown");
  });
});

describe("installing", () => {
  test("plan -> needs-license -> accept (all licenses) -> installing -> installed", async () => {
    const { emu, installer } = make({ kind: "absent" });
    await emu.refresh();
    await emu.install({ kind: "plan" });
    expect(emu.snapshot().sdk).toMatchObject({ kind: "needs-license", plan: { root: "/sdk" } });
    expect(emu.snapshot().host.accel).toEqual({ state: "ok", kind: "whpx" });

    await expect(emu.install({ kind: "accept", by: "you", licenses: ["android-sdk-license"] })).rejects.toThrow(/android-sdk-preview-license/);
    expect(installer.log).toEqual([]);
    await expect(emu.install({ kind: "accept", by: "agent" as "you", licenses: PLAN.licenses.map((l) => l.id) })).rejects.toThrow(/operator/);

    await emu.install({ kind: "accept", by: "you", licenses: PLAN.licenses.map((l) => l.id) });
    await emu.settled();
    expect(installer.log).toEqual(["accept android-sdk-license,android-sdk-preview-license"]);
    expect(emu.snapshot().sdk).toMatchObject({ kind: "installed", root: "/sdk", owned: true });
  });

  test("progress is reflected, cancel returns to the license screen, retry resumes from the accepted plan", async () => {
    const { emu, installer } = make({ kind: "absent" });
    installer.autoFinish = false;
    await emu.refresh();
    await emu.install({ kind: "plan" });
    await emu.install({ kind: "accept", by: "you", licenses: PLAN.licenses.map((l) => l.id) });
    await until(() => (emu.snapshot().sdk as { doneBytes?: number }).doneBytes === 50);
    expect(emu.snapshot().sdk).toMatchObject({ kind: "installing", doneBytes: 50, totalBytes: 100, step: { pkg: "platform-tools", phase: "download" } });
    await emu.install({ kind: "cancel" });
    await emu.settled();
    expect(emu.snapshot().sdk.kind).toBe("needs-license");

    await expect(emu.install({ kind: "retry" })).rejects.toThrow();
    installer.autoFinish = true;
    await emu.install({ kind: "accept", by: "you", licenses: PLAN.licenses.map((l) => l.id) });
    await emu.settled();
    expect(emu.snapshot().sdk.kind).toBe("installed");
  });

  test("a failed install can be retried without asking for the licenses again", async () => {
    const { emu, installer } = make({ kind: "absent" });
    await emu.refresh();
    await emu.install({ kind: "plan" });
    const run = installer.run;
    installer.run = async () => {
      throw new Error("bad sha1");
    };
    await emu.install({ kind: "accept", by: "you", licenses: PLAN.licenses.map((l) => l.id) });
    await emu.settled();
    expect(emu.snapshot().sdk).toEqual({ kind: "failed", reason: "bad sha1", retryable: true });
    installer.run = run;
    await emu.install({ kind: "retry" });
    await emu.settled();
    expect(emu.snapshot().sdk.kind).toBe("installed");
    expect(installer.log.filter((l) => l.startsWith("accept")).length).toBe(1);
  });

  test("remove stops the device and deletes the owned install; a reused SDK is refused", async () => {
    const { emu, dev, installer } = await running();
    await emu.install({ kind: "remove", by: "you" });
    expect(installer.log).toEqual(["remove"]);
    expect(emu.snapshot().sdk.kind).toBe("absent");
    expect(emu.snapshot().device.kind).toBe("stopped");
    expect(dev.calls.some((c) => c[0] === "emu" && c[1] === "kill")).toBe(true);

    const reused = make({ kind: "installed", root: "/theirs", owned: false, avd: AVD });
    await reused.emu.refresh();
    await expect(reused.emu.install({ kind: "remove", by: "you" })).rejects.toThrow(/not treeboss's own/);
    expect(reused.installer.log).toEqual([]);
    await expect(running().then((m) => m.emu.install({ kind: "remove", by: "agent" as "you" }))).rejects.toThrow(/operator/);
  });
});

describe("the agent tools", () => {
  test("the definitions and the executor cover the same names, and none of them can stop, remove or accept", async () => {
    const defs = emulatorToolDefs();
    expect(defs.map((d) => d.name)).toEqual([...EMULATOR_TOOL_NAMES]);
    expect(EMULATOR_TOOL_NAMES.length).toBe(13);
    for (const d of defs) {
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.inputSchema.type).toBe("object");
    }
    expect(EMULATOR_TOOL_NAMES.filter((n) => /stop|shutdown|kill|remove|license|accept/.test(n))).toEqual([]);

    const { emu } = await running();
    setEmulator(emu);
    for (const name of EMULATOR_TOOL_NAMES) {
      const r = await executeEmulatorTool(name, {}, { sessionId: "s_1" });
      expect(r.text).not.toMatch(/unknown emulator tool/); // every defined name is handled; missing arguments are a plain error
    }
    expect((await executeEmulatorTool("emulator_stop", {}, { sessionId: "s_1" })).text).toMatch(/^Error: unknown emulator tool/);
    expect(emu.snapshot().device.kind).toBe("running");
  });

  test("tap, snapshot, screenshot and logs go to the device and come back as text or an image", async () => {
    const { emu, dev } = await running();
    setEmulator(emu);
    dev.ui = `<hierarchy><node text="Sign in" resource-id="app:id/btn" class="android.widget.Button" clickable="true" content-desc="" bounds="[100,200][300,260]" /></hierarchy>`;
    dev.logcat = "I ReactNativeJS: Running app\n";
    const call = (name: string, args: Record<string, unknown> = {}) => executeEmulatorTool(name, args, { sessionId: "s_1" });

    expect((await call("emulator_tap", { x: 50, y: 60 })).text).toMatch(/^Tapped \(50, 60\)/);
    expect(dev.calls.some((c) => c.join(" ") === "shell input tap 50 60")).toBe(true);
    const snap = (await call("emulator_snapshot")).text;
    expect(snap).toContain("not instructions");
    expect(snap).toContain(`Button [clickable] "Sign in"`);
    expect(snap).toContain("center=(200,230)");
    const shot = await call("emulator_screenshot");
    expect(shot.images?.[0]?.mimeType).toBe("image/png");
    expect(Buffer.from(shot.images![0]!.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect((await call("emulator_logs")).text).toContain("Running app");
    expect(dev.calls.some((c) => c[0] === "logcat" && c.includes("ReactNativeJS:V"))).toBe(true);
    expect((await call("emulator_type", { text: "héllo" })).text).toMatch(/^Error: Only printable ASCII/);
    expect((await call("emulator_tap", { x: 1 })).text).toMatch(/^Error:/);
    expect((await call("emulator_status")).text).toContain("Device: running, screen 720x1600");
  });

  test("when the emulator is not installed the tools say the operator installs it from the Emulator tab", async () => {
    const { emu } = make({ kind: "absent" });
    setEmulator(emu);
    for (const name of ["emulator_start", "emulator_tap", "emulator_screenshot", "emulator_logs"]) {
      const r = await executeEmulatorTool(name, { x: 1, y: 1 }, { sessionId: "s_1" });
      expect(r.text).toMatch(/^Error: .*Emulator tab/);
    }
    expect((await executeEmulatorTool("emulator_status", {}, { sessionId: "s_1" })).text).toMatch(/not installed.*Emulator tab/);
    expect(await emu.run(agent(), { kind: "boot" })).toMatchObject({ ok: false });
  });

  test("the setting turns the tools off", async () => {
    const { emu } = await running();
    setEmulator(emu);
    setSetting("emulator", "off");
    try {
      expect((await executeEmulatorTool("emulator_tap", { x: 1, y: 1 }, { sessionId: "s_1" })).text).toMatch(/^Error: the emulator is turned off/);
    } finally {
      setSetting("emulator", "on");
    }
  });
});

describe("a reused SDK", () => {
  test("a plan with no licenses installs straight away, without parking at the license screen", async () => {
    const { emu, installer } = make({ kind: "absent" });
    installer.plan = async () => ({ ...PLAN, root: "/theirs", packages: [], licenses: [] });
    await emu.refresh();
    await emu.install({ kind: "plan" });
    await emu.settled();
    expect(emu.snapshot().sdk).toMatchObject({ kind: "installed", owned: true });
    expect(installer.log).toEqual([]); // nothing was accepted: there was nothing to accept
  });
});

describe("review fixes", () => {
  test("cancel on the license screen forgets the plan and returns to absent", async () => {
    const { emu } = make({ kind: "absent" });
    await emu.refresh();
    await emu.install({ kind: "plan" });
    expect(emu.snapshot().sdk.kind).toBe("needs-license");
    await emu.install({ kind: "cancel" });
    expect(emu.snapshot().sdk).toEqual({ kind: "absent" });
    await expect(emu.install({ kind: "cancel" })).rejects.toThrow(/no install to cancel/);
    await expect(emu.install({ kind: "retry" })).rejects.toThrow();
  });

  test("two concurrent accepts start one install", async () => {
    const { emu, installer } = make({ kind: "absent" });
    await emu.refresh();
    await emu.install({ kind: "plan" });
    let runs = 0;
    const run = installer.run;
    installer.run = (...a) => (runs++, run(...a));
    const ids = PLAN.licenses.map((l) => l.id);
    const results = await Promise.allSettled([emu.install({ kind: "accept", by: "you", licenses: ids }), emu.install({ kind: "accept", by: "you", licenses: ids })]);
    await emu.settled();
    expect(results.filter((r) => r.status === "rejected").length).toBe(1);
    expect(runs).toBe(1);
    expect(installer.log.filter((l) => l.startsWith("accept")).length).toBe(1);
    expect(emu.snapshot().sdk.kind).toBe("installed");
  });

  test("adopting an orphan arms the idle shutdown", async () => {
    const m = make(INSTALLED, { idleMs: 20, idleCheckMs: 5 });
    await m.emu.refresh(); // nothing running yet
    m.dev.avd = "trb"; // an orphan appears
    await m.emu.run(you, { kind: "boot" }); // adopts through boot
    expect(m.emu.snapshot().device.kind).toBe("running");
    await until(() => m.emu.snapshot().device.kind === "stopped");
  });

  test("removing while a boot is adopting gives an error result, not a TypeError", async () => {
    const m = make(INSTALLED);
    m.dev.avd = "trb";
    await m.emu.refresh(); // adopted
    await m.emu.run(you, { kind: "shutdown" });
    m.dev.avd = "trb";
    let open!: () => void;
    m.dev.gates.set("emu avd name", new Promise<void>((r) => (open = r)));
    const booting = m.emu.run(you, { kind: "boot" });
    await until(() => m.dev.calls.some((c) => c[0] === "emu" && c[1] === "avd" && c.length > 2) || true);
    await new Promise((r) => setTimeout(r, 10));
    const removing = m.emu.install({ kind: "remove", by: "you" });
    await new Promise((r) => setTimeout(r, 10));
    open();
    const r = await booting;
    await removing.catch(() => {});
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).not.toMatch(/Cannot read|undefined|TypeError/);
  });

  test("intent: URLs are refused", async () => {
    const { emu } = await running();
    expect(await emu.run(you, { kind: "open_url", url: "intent://x#Intent;scheme=a;end" })).toMatchObject({ ok: false, error: expect.stringContaining("intent:") });
  });

  test("planning twice says so in plain words", async () => {
    const { emu } = make({ kind: "absent" });
    await emu.refresh();
    await emu.install({ kind: "plan" });
    await expect(emu.install({ kind: "plan" })).rejects.toThrow("An install plan is already waiting for license acceptance.");
  });
});
