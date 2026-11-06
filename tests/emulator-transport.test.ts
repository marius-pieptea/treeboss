/** What the emulator sends over adb: the argv for each input, and that it reaches the device's shell as one safe word each. */
import { describe, expect, test } from "bun:test";
import { adbClient, shq, SERIAL } from "../src/emulator/adb";
import type { Deps } from "../src/emulator/deps";
import { InputError, adbTransport, inputArgv } from "../src/emulator/transport";
import { EMULATOR_KEYS } from "../src/emulator/types";

describe("inputArgv", () => {
  test("tap, long press and swipe use whole device pixels", () => {
    expect(inputArgv({ kind: "tap", x: 100.4, y: 200.6 })).toEqual(["input", "tap", "100", "201"]);
    expect(inputArgv({ kind: "long_press", x: 10, y: 20 })).toEqual(["input", "swipe", "10", "20", "10", "20", "800"]);
    expect(inputArgv({ kind: "long_press", x: 10, y: 20, ms: 1200 })).toEqual(["input", "swipe", "10", "20", "10", "20", "1200"]);
    expect(inputArgv({ kind: "swipe", x1: 1, y1: 2, x2: 3, y2: 4 })).toEqual(["input", "swipe", "1", "2", "3", "4", "300"]);
    expect(inputArgv({ kind: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, ms: 999999 })[6]).toBe("10000");
  });

  test("a bad coordinate is an input error, not a command that runs", () => {
    expect(() => inputArgv({ kind: "tap", x: -1, y: 0 })).toThrow(InputError);
    expect(() => inputArgv({ kind: "tap", x: Number.NaN, y: 0 })).toThrow(InputError);
  });

  test("text: spaces become %s, other printable characters pass through for the quoting layer", () => {
    expect(inputArgv({ kind: "text", text: "hello world" })).toEqual(["input", "text", "hello%sworld"]);
    expect(inputArgv({ kind: "text", text: `it's "a" & b; c|d $HOME` })[2]).toBe(`it's%s"a"%s&%sb;%sc|d%s$HOME`);
  });

  test("text: anything `input text` cannot type is refused whole, not typed partly", () => {
    for (const bad of ["héllo", "emoji 🙂", "日本語", "two\nlines", ""]) expect(() => inputArgv({ kind: "text", text: bad })).toThrow(InputError);
  });

  test("a literal %s cannot be typed (input text reads it as a space), so it is refused", () => {
    expect(() => inputArgv({ kind: "text", text: "50%sale" })).toThrow(/%s/);
    expect(inputArgv({ kind: "text", text: "100%" })[2]).toBe("100%");
  });

  test("every key has a keycode, and rotate sets the user rotation", () => {
    for (const key of EMULATOR_KEYS) expect(inputArgv({ kind: "key", key })).toEqual(["input", "keyevent", expect.stringMatching(/^KEYCODE_[A-Z_]+$/)]);
    expect(inputArgv({ kind: "key", key: "recents" })[2]).toBe("KEYCODE_APP_SWITCH");
    expect(inputArgv({ kind: "rotate", to: "landscape" })[2]).toContain("user_rotation 1");
    expect(inputArgv({ kind: "rotate", to: "portrait" })[2]).toContain("user_rotation 0");
  });
});

describe("shq", () => {
  test("plain words stay as they are, everything else becomes one single-quoted word", () => {
    expect(shq("input")).toBe("input");
    expect(shq("a%sb")).toBe("a%sb");
    expect(shq("a&b;c")).toBe("'a&b;c'");
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(shq("")).toBe("''");
  });
});

function recordingDeps(): { deps: Deps; calls: string[][] } {
  const calls: string[][] = [];
  const deps: Deps = {
    exec: {
      run: async (argv) => (calls.push(argv), { code: 0, stdout: new Uint8Array(), stderr: "" }),
      spawn: () => {
        throw new Error("no spawn");
      },
    },
    fetch: { text: async () => "", download: async () => {} },
    now: () => 0,
    paths: { root: "/sdk", avdHome: "/avd", tmp: "/tmp" },
  };
  return { deps, calls };
}

describe("adbTransport.input", () => {
  test("sends one adb shell command per input, quoted for the device", async () => {
    const { deps, calls } = recordingDeps();
    await adbTransport(adbClient(deps, "adb", SERIAL)).input({ kind: "text", text: "a & b; c" });
    expect(calls).toEqual([["adb", "-s", SERIAL, "shell", "input text 'a%s&%sb;%sc'"]]);
  });

  test("a newline types the parts with Enter between them", async () => {
    const { deps, calls } = recordingDeps();
    await adbTransport(adbClient(deps, "adb", SERIAL)).input({ kind: "text", text: "one\ntwo" });
    expect(calls.map((c) => c[4])).toEqual(["input text one", "input keyevent KEYCODE_ENTER", "input text two"]);
  });

  test("rotate runs through the device's sh as one command", async () => {
    const { deps, calls } = recordingDeps();
    await adbTransport(adbClient(deps, "adb", SERIAL)).input({ kind: "rotate", to: "landscape" });
    expect(calls[0]![4]).toBe("sh -c 'settings put system accelerometer_rotation 0 && settings put system user_rotation 1'");
  });
});
