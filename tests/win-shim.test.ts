import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { shimInvocation } from "../src/engines/win-shim";

describe("shimInvocation", () => {
  test("off Windows, and for a real executable, the command is left alone", () => {
    expect(shimInvocation("/usr/bin/cursor-agent", ["-p"], "linux")).toEqual({ file: "/usr/bin/cursor-agent", args: ["-p"], verbatim: false });
    expect(shimInvocation("C:\\bin\\claude.exe", ["-p"], "win32")).toEqual({ file: "C:\\bin\\claude.exe", args: ["-p"], verbatim: false });
  });

  test("on Windows, a .cmd or .bat shim runs through cmd.exe /d /s /c", () => {
    const inv = shimInvocation("C:\\Users\\me\\cursor-agent.cmd", ["--model", "auto"], "win32");
    expect(inv.verbatim).toBe(true);
    expect(inv.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(inv.args[3]).toStartWith('"');
    expect(inv.args[3]).toEndWith('"');
    // The file is escaped once (one cmd parse), each argument twice (the shim's own parse of %*).
    expect(inv.args[3]).toBe('"^"C:\\Users\\me\\cursor-agent.cmd^" ^^^"--model^^^" ^^^"auto^^^""');
  });
});

describe.skipIf(process.platform !== "win32")("a .cmd shim, really spawned", () => {
  test("arguments arrive intact, metacharacters included", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-shim-"));
    try {
      // The shim is a .cmd that runs bun on a script echoing its argv as JSON, the way cursor-agent.cmd runs powershell.
      const script = path.join(dir, "argv.js");
      fs.writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));");
      const shim = path.join(dir, "cursor-agent.cmd");
      fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
      const args = ["--workspace", "C:\\with space\\dir\\", "a&b|c>d<e", 'say "hi"', "x^y", "(paren)", "100%", "semi;comma,eq=", "plain"];
      const inv = shimInvocation(shim, args);
      const r = spawnSync(inv.file, inv.args, { windowsVerbatimArguments: inv.verbatim, encoding: "utf-8", windowsHide: true });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual(args);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
