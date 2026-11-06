import { describe, expect, test } from "bun:test";
import { EMULATOR_KEYS } from "../../web/src/features/emulator/emulator-api";
import { emulatorTab, openEmulator } from "../../web/src/features/emulator/open";
import { tabId } from "../../web/src/lib/store";
import { useUi } from "../../web/src/lib/store";

describe("the emulator tab", () => {
  test("is one tab with the id emulator, whatever opens it", () => {
    expect(emulatorTab()).toEqual({ kind: "emulator", title: "Emulator" });
    expect(tabId(emulatorTab())).toBe("emulator");
  });

  test("openEmulator asks the store for that tab each time (the store focuses an open one)", () => {
    const openTab = useUi.getState().openTab;
    const seen: unknown[] = [];
    useUi.setState({ openTab: ((t) => (seen.push(t), "emulator")) as typeof openTab });
    openEmulator();
    openEmulator();
    useUi.setState({ openTab });
    expect(seen).toEqual([emulatorTab(), emulatorTab()]);
  });
});

describe("the key list the phone accepts", () => {
  // Hardcoded from the design (src/emulator/types.ts on the server): the web cannot import src/, so a change on either side must fail here.
  test("matches the server's", () => {
    expect([...EMULATOR_KEYS]).toEqual(["back", "home", "recents", "enter", "delete", "tab", "escape", "power", "volume_up", "volume_down", "menu", "dpad_up", "dpad_down", "dpad_left", "dpad_right"]);
  });
});
