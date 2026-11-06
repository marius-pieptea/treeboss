import { describe, expect, test } from "bun:test";
import path from "path";
import { revealCommand } from "../src/daemon/routes/x_fs";

const explorer = path.win32.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe");

describe("revealCommand", () => {
  test("Windows selects a file inside Explorer, quoted for paths with spaces", () => {
    expect(revealCommand("win32", "C:\\work\\my app\\a.ts", false)).toEqual({ cmd: explorer, args: ['/select,"C:\\work\\my app\\a.ts"'] });
  });

  test("Windows opens a folder rather than selecting it", () => {
    expect(revealCommand("win32", "C:\\work\\src", true)).toEqual({ cmd: explorer, args: ['"C:\\work\\src"'] });
  });

  test("macOS reveals a file in Finder and opens a folder", () => {
    expect(revealCommand("darwin", "/Users/me/app/a.ts", false)).toEqual({ cmd: "open", args: ["-R", "/Users/me/app/a.ts"] });
    expect(revealCommand("darwin", "/Users/me/app/src", true)).toEqual({ cmd: "open", args: ["/Users/me/app/src"] });
  });

  test("Linux opens the containing folder for a file, the folder itself otherwise", () => {
    expect(revealCommand("linux", "/home/me/app/a.ts", false)).toEqual({ cmd: "xdg-open", args: [path.dirname("/home/me/app/a.ts")] });
    expect(revealCommand("linux", "/home/me/app/src", true)).toEqual({ cmd: "xdg-open", args: ["/home/me/app/src"] });
  });
});
