import { describe, expect, test } from "bun:test";
import { buildTermTheme, clampFont, extractFileLinks, findInRows, newPorts, portsForWorkspace, rootLabel, type ThemeVars } from "../../web/src/features/terminal/logic";
import { DEVICES, clampZoom, computeFrame, defaultResponsiveWidth, normalizeUrl, reachability, titleFor, type UiOrigin } from "../../web/src/features/browser/logic";
import type { ListeningPort } from "../../web/src/lib/types";

const ui: UiOrigin = { origin: "http://127.0.0.1:4477", hostname: "127.0.0.1", port: "4477" };
const uiLocalhost: UiOrigin = { origin: "http://localhost:4477", hostname: "localhost", port: "4477" };

describe("normalizeUrl", () => {
  test("port shorthands become localhost URLs", () => {
    for (const [input, want] of [
      [":3000", "http://localhost:3000"],
      ["3000", "http://localhost:3000"],
      [":5173/docs?x=1", "http://localhost:5173/docs?x=1"],
      ["localhost:8080", "http://localhost:8080"],
      ["localhost:8080/a/b", "http://localhost:8080/a/b"],
    ] as const) {
      const r = normalizeUrl(input, ui);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe(want);
    }
  });

  test("hosts without a scheme: https for the public web, http for local names", () => {
    expect((normalizeUrl("example.com/docs", ui) as any).url).toBe("https://example.com/docs");
    expect((normalizeUrl("my-app.local:3000", ui) as any).url).toBe("http://my-app.local:3000");
    expect((normalizeUrl("192.168.1.20:3000", ui) as any).url).toBe("http://192.168.1.20:3000");
  });

  test("only http and https load: script and data URLs are rejected", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "blob:http://x/1", "about:blank", "chrome://settings", "ftp://example.com"]) {
      const r = normalizeUrl(bad, ui);
      expect(r.ok).toBe(false);
    }
  });

  test("the app's own origin is refused under every loopback spelling", () => {
    for (const same of [":4477", "http://127.0.0.1:4477/api/sessions", "localhost:4477", "http://[::1]:4477", "http://0.0.0.0:4477/"]) {
      const r = normalizeUrl(same, ui);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("app itself");
    }
    expect(normalizeUrl("localhost:4477", uiLocalhost).ok).toBe(false);
    expect(normalizeUrl(":4478", ui).ok).toBe(true);
  });

  test("loopback previews use the other loopback name, so the app's cookie never reaches the dev server", () => {
    const a = normalizeUrl("http://127.0.0.1:3000/x", ui);
    expect(a).toMatchObject({ ok: true, url: "http://localhost:3000/x", rewrittenHost: true });
    const b = normalizeUrl("http://localhost:3000", uiLocalhost);
    expect(b).toMatchObject({ ok: true, url: "http://127.0.0.1:3000", rewrittenHost: true });
    expect(normalizeUrl(":3000", ui)).toMatchObject({ ok: true, url: "http://localhost:3000" });
    expect((normalizeUrl("http://192.168.1.2:3000", ui) as any).rewrittenHost).toBeFalsy();
  });

  test("credentials, bare words, empty input and bad ports are refused with a reason", () => {
    expect(normalizeUrl("http://user:pw@localhost:3000", ui).ok).toBe(false);
    expect(normalizeUrl("hello world", ui).ok).toBe(false);
    expect(normalizeUrl("react hooks", ui).ok).toBe(false);
    expect(normalizeUrl("   ", ui).ok).toBe(false);
    expect(normalizeUrl(":99999", ui).ok).toBe(false);
  });

  test("titles are short and readable", () => {
    expect(titleFor("http://localhost:3000/")).toBe("localhost:3000");
    expect(titleFor("https://example.com/docs/getting-started")).toBe("example.com/docs/getting-started");
    expect(titleFor("not a url")).toBe("not a url");
  });
});

describe("device frames", () => {
  const dev = (id: string) => DEVICES.find((d) => d.id === id)!;
  const avail = { w: 1000, h: 600 };

  test("a fixed device keeps its size and fits the pane without ever enlarging", () => {
    const f = computeFrame({ device: dev("iphone"), rotated: false, avail, zoom: 1, fit: true, responsiveW: 0 });
    expect(f).toMatchObject({ width: 393, height: 852 });
    expect(f.scale).toBeCloseTo(600 / 852, 3); // height is the binding side
    const big = computeFrame({ device: dev("iphone"), rotated: false, avail: { w: 2000, h: 2000 }, zoom: 1, fit: true, responsiveW: 0 });
    expect(big.scale).toBe(1);
  });

  test("rotating swaps width and height", () => {
    const f = computeFrame({ device: dev("ipad"), rotated: true, avail: { w: 2000, h: 2000 }, zoom: 1, fit: true, responsiveW: 0 });
    expect(f).toMatchObject({ width: 1180, height: 820, scale: 1 });
  });

  test("without fit, zoom applies and is clamped", () => {
    expect(computeFrame({ device: dev("laptop"), rotated: false, avail, zoom: 0.5, fit: false, responsiveW: 0 }).scale).toBe(0.5);
    expect(computeFrame({ device: dev("laptop"), rotated: false, avail, zoom: 9, fit: false, responsiveW: 0 }).scale).toBe(2);
    expect(clampZoom(0.01)).toBe(0.25);
  });

  test("responsive: width is the user's, height fills the pane at the current zoom", () => {
    const f = computeFrame({ device: dev("responsive"), rotated: false, avail, zoom: 0.5, fit: true, responsiveW: 700 });
    expect(f).toEqual({ width: 700, height: 1200, scale: 0.5 });
    expect(computeFrame({ device: dev("responsive"), rotated: false, avail, zoom: 1, fit: false, responsiveW: 10 }).width).toBe(240);
    expect(defaultResponsiveWidth(1000, 0.5)).toBe(2000);
  });
});

describe("file links in terminal output", () => {
  const link = (s: string, cwd?: string) => extractFileLinks(s, cwd).map((l) => ({ path: l.path, line: l.line, col: l.col, text: s.slice(l.start, l.end) }));

  test("path:line:col and path:line", () => {
    expect(link("src/greet.ts:12:5 error TS2322")).toEqual([{ path: "src/greet.ts", line: 12, col: 5, text: "src/greet.ts:12:5" }]);
    expect(link("at foo (src/utils/math.ts:3)")).toEqual([{ path: "src/utils/math.ts", line: 3, col: undefined, text: "src/utils/math.ts:3" }]);
  });

  test("a bare path, with dots and dashes in names", () => {
    expect(link("modified: web/src/features/git-panel.test.tsx")[0].path).toBe("web/src/features/git-panel.test.tsx");
    expect(link("see ./README.md for more")[0]).toMatchObject({ path: "README.md", text: "./README.md" });
    expect(link("my-file_v2.config.json")[0].path).toBe("my-file_v2.config.json");
  });

  test("compiler style path(line,col)", () => {
    expect(link("src/a.ts(14,7): error")).toEqual([{ path: "src/a.ts", line: 14, col: 7, text: "src/a.ts(14,7)" }]);
  });

  test("URLs, timestamps and version numbers are not file links", () => {
    expect(link("GET http://localhost:3000/assets/app.js:1 200")).toEqual([]);
    expect(link("https://example.com/a/b.html")).toEqual([]);
    expect(link("12:30:45 started")).toEqual([]);
    expect(link("node v20.11.1 and bun 1.3.14")).toEqual([]);
    expect(link("total 48")).toEqual([]);
  });

  test("absolute paths only inside the terminal's root, and no escapes", () => {
    expect(link("/work/app/src/a.ts:9", "/work/app")).toEqual([{ path: "src/a.ts", line: 9, col: undefined, text: "/work/app/src/a.ts:9" }]);
    expect(link("/etc/passwd.txt:1", "/work/app")).toEqual([]);
    expect(link("/work/app/src/a.ts:9")).toEqual([]);
    expect(link("../outside/a.ts:1")).toEqual([]);
    expect(link("~/notes.md")).toEqual([]);
  });

  test("several links in a line, in order", () => {
    const l = link("src/a.ts:1 -> src/b.ts:2");
    expect(l.map((x) => x.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("buffer search", () => {
  test("finds every occurrence per row, case-insensitively by default", () => {
    expect(findInRows(["Error: one", "no match", "error error"], "error")).toEqual([
      { row: 0, col: 0, len: 5 },
      { row: 2, col: 0, len: 5 },
      { row: 2, col: 6, len: 5 },
    ]);
    expect(findInRows(["Error", "error"], "Error", true)).toEqual([{ row: 0, col: 0, len: 5 }]);
    expect(findInRows(["aaa"], "aa")).toEqual([{ row: 0, col: 0, len: 2 }]);
    expect(findInRows(["abc"], "")).toEqual([]);
  });
});

describe("ports", () => {
  const p = (port: number, cwd: string | null, pid = port): ListeningPort => ({ port, pid, command: "bun", cwd, address: "127.0.0.1" });
  const ports = [p(3000, "/work/app"), p(5173, "/work/app/web"), p(8080, "/work/other"), p(4477, "/work/app"), p(9000, null), p(3000, "/work/app", 99)];

  test("only servers inside the workspace, never the daemon's port, one per port", () => {
    expect(portsForWorkspace(ports, "/work/app", { ownPort: 4477 }).map((x) => x.port)).toEqual([3000, 5173]);
  });

  test("a sibling directory with a shared prefix is not inside", () => {
    expect(portsForWorkspace([p(1, "/work/app-two")], "/work/app")).toEqual([]);
  });

  test("`all` shows everything reachable", () => {
    expect(portsForWorkspace(ports, "/work/app", { all: true, ownPort: 4477 }).map((x) => x.port)).toEqual([3000, 5173, 8080, 9000]);
  });

  test("new ports are those not seen before", () => {
    expect(newPorts(new Set([3000]), [p(3000, "/w"), p(5173, "/w")]).map((x) => x.port)).toEqual([5173]);
  });
});

describe("theme and labels", () => {
  const vars: ThemeVars = { "--panel": "#0e1115", "--fg": "#d8dee7", "--fg-muted": "#8a95a4", "--fg-faint": "#5a6471", "--accent": "#45d4e6", "--accent-fg": "#03171b", "--green": "#4ade80", "--red": "#f87171", "--amber": "#fbbf24", "--blue": "#60a5fa", "--violet": "#a78bfa", "--raised": "#141920", "--active": "rgba(255,255,255,0.085)" };

  test("the palette is drawn from the app's own colours", () => {
    const t = buildTermTheme(vars, true);
    expect(t).toMatchObject({ background: "#0e1115", foreground: "#d8dee7", cursor: "#45d4e6", red: "#f87171", green: "#4ade80", yellow: "#fbbf24", blue: "#60a5fa", magenta: "#a78bfa", cyan: "#45d4e6" });
  });

  test("bright colours flip per theme so light backgrounds stay readable", () => {
    const dark = buildTermTheme(vars, true);
    const light = buildTermTheme({ ...vars, "--panel": "#ffffff", "--fg": "#1c2330" }, false);
    expect(dark.brightWhite).not.toBe(light.brightWhite);
    expect(light.brightRed).toBe("#b91c1c");
    expect(light.background).toBe("#ffffff");
  });

  test("a terminal tab names its head, or nothing for the workspace root", () => {
    const heads = [{ id: "s_1", role: "scout", engine: "claude" }, { id: "s_2", role: null, engine: "codex" }];
    expect(rootLabel("w_1", "w_1", heads)).toBeNull();
    expect(rootLabel("s_1", "w_1", heads)).toBe("scout");
    expect(rootLabel("s_2", "w_1", heads)).toBe("codex");
    expect(rootLabel("s_unknownzzz", "w_1", heads)).toBe("s_unknow");
  });

  test("font size stays in range", () => {
    expect(clampFont(3)).toBe(10);
    expect(clampFont(40)).toBe(22);
    expect(clampFont(13.4)).toBe(13);
  });
});

describe("reachability", () => {
  const listening = [{ port: 4477 }, { port: 3000 }];
  test("a local URL is up when its port is listening, down when it is not", () => {
    expect(reachability("http://localhost:3000/x", listening)).toBe("up");
    expect(reachability("http://localhost:3999", listening)).toBe("down");
    expect(reachability("http://127.0.0.1:3000", listening)).toBe("up");
  });
  test("default ports follow the scheme", () => {
    expect(reachability("http://localhost", [{ port: 80 }])).toBe("up");
    expect(reachability("https://localhost", [{ port: 80 }])).toBe("down");
  });
  test("remote hosts, bad URLs and an unreadable port list are unknown, never down", () => {
    expect(reachability("https://example.com", listening)).toBe("unknown");
    expect(reachability("not a url", listening)).toBe("unknown");
    expect(reachability("http://localhost:3000", [])).toBe("unknown");
  });
});
