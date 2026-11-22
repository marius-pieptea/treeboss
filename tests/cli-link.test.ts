import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { cliLinkStatus, installCliLink, type CliLinkEnv } from "../src/cli-link";
import { cliLinkOffer } from "../web/src/features/settings/logic";

/** A fake machine: an app bundle with a trb binary, a home, a system bin folder, and a shell PATH. */
function machine(opts: { systemWritable?: boolean; onPath?: Array<"system" | "local"> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trb-clilink-"));
  const binary = path.join(root, "TreeBoss.app", "Contents", "Resources", "bin", "trb");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
  const home = path.join(root, "home");
  const systemBin = path.join(root, "usr-local-bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(systemBin, { recursive: true });
  if (opts.systemWritable === false) fs.chmodSync(systemBin, 0o555);
  const dirs = { system: systemBin, local: path.join(home, ".local", "bin") };
  const env: CliLinkEnv = { binary, home, systemBin, shellPath: ["/usr/bin", ...(opts.onPath ?? []).map((k) => dirs[k])] };
  return { env, binary, ...dirs };
}

describe("putting trb on the PATH", () => {
  test("not installed: the folder on PATH is offered, and installing links it to the app's binary", () => {
    const m = machine({ onPath: ["system"] });
    const before = cliLinkStatus(m.env);
    expect(before.installed).toBe(false);
    expect(cliLinkOffer(before)?.target).toBe(path.join(m.system, "trb"));
    const r = installCliLink(null, m.env);
    expect(r.linked).toBe(path.join(m.system, "trb"));
    expect(fs.realpathSync(r.linked)).toBe(fs.realpathSync(m.binary));
    expect(r.status.installed).toBe(true);
    expect(r.note).toBeNull();
    expect(cliLinkOffer(r.status)).toBeNull(); // nothing more to offer
  });

  test("an unwritable /usr/local/bin falls back to ~/.local/bin, and says to add it to PATH when it is not there", () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    const m = machine({ systemWritable: false });
    const r = installCliLink(null, m.env);
    expect(r.linked).toBe(path.join(m.local, "trb"));
    expect(r.note).toContain(`export PATH="${m.local}:$PATH"`);
    fs.chmodSync(m.system, 0o755);
  });

  test("a file that is not a trb link is never overwritten", () => {
    const m = machine({ onPath: ["system"] });
    fs.writeFileSync(path.join(m.system, "trb"), "someone else's trb\n");
    expect(() => installCliLink(path.join(m.system, "trb"), m.env)).toThrow(/already exists and is not a link to trb/);
    expect(fs.readFileSync(path.join(m.system, "trb"), "utf-8")).toBe("someone else's trb\n");
  });

  test("a stale link to an older trb is replaced", () => {
    const m = machine({ onPath: ["system"] });
    const old = path.join(path.dirname(m.binary), "..", "old", "trb");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, "");
    fs.symlinkSync(old, path.join(m.system, "trb"));
    expect(cliLinkStatus(m.env).targets[0]!.state).toBe("stale");
    installCliLink(null, m.env);
    expect(cliLinkStatus(m.env).installed).toBe(true);
  });

  test("a daemon run from source has nothing to link, and the card says nothing", () => {
    const m = machine();
    const env = { ...m.env, binary: null };
    expect(cliLinkOffer(cliLinkStatus(env))).toBeNull();
    expect(() => installCliLink(null, env)).toThrow(/runs from source/);
  });

  /** A Windows machine: the app's bin dir with trb.exe inside, a persistent PATH that lacks it, and a PATH writer. */
  function winMachine(opts: { onPath?: boolean } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trb-clilink-win-"));
    const binDir = path.join(root, "resources", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binary = path.join(binDir, "trb.exe");
    fs.writeFileSync(binary, "MZ");
    const shellPath = [...(opts.onPath ? [binDir] : []), "C:\\Windows"];
    const added: string[] = [];
    const env: CliLinkEnv = { binary, home: root, shellPath, platform: "win32", addToUserPath: (d) => { added.push(d); shellPath.push(d); } };
    return { env, binDir, binary, added };
  }

  test("windows: the app's bin folder is offered and installing puts it on the user PATH", () => {
    const m = winMachine();
    const before = cliLinkStatus(m.env);
    expect(before.installed).toBe(false);
    expect(before.targets).toEqual([{ path: m.binDir, state: "absent", writable: true, onPath: false }]);
    expect(cliLinkOffer(before)).toMatchObject({ target: m.binDir });
    expect(cliLinkOffer(before)!.text).toContain("PATH");
    const r = installCliLink(null, m.env);
    expect(m.added).toEqual([m.binDir]);
    expect(r.status.installed).toBe(true);
    expect(cliLinkOffer(r.status)).toBeNull();
  });

  test("windows: the app's bin folder already on PATH is installed, nothing is offered", () => {
    const m = winMachine({ onPath: true });
    expect(cliLinkStatus(m.env).installed).toBe(true);
    expect(cliLinkOffer(cliLinkStatus(m.env))).toBeNull();
  });
});
