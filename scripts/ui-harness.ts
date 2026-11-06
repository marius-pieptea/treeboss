/**
 * Drive the real UI in headless Chrome against a real daemon (scripted engine, throwaway home), for
 * screenshots and end-to-end checks. Not part of `bun test`: it needs Chrome and takes seconds per run.
 *
 *   bun run scripts/ui-harness.ts shot /tmp/out.png
 *   import { withUi } from "./ui-harness";   // from an ad-hoc script
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { chromium, type Browser, type Page } from "playwright-core";

const ROOT = path.resolve(import.meta.dir, "..");
const MAIN = path.join(ROOT, "src", "cli", "main.ts");

export interface UiEnv {
  page: Page;
  browser: Browser;
  home: string;
  repo: string;
  workspaceId: string;
  url: string;
  trb(...args: string[]): { stdout: string; stderr: string; code: number | null };
  shot(name: string, opts?: { fullPage?: boolean }): Promise<string>;
}

export function sampleRepo(dir: string): void {
  const sh = (c: string) => spawnSync("bash", ["-c", c], { cwd: dir, encoding: "utf-8" });
  fs.mkdirSync(dir, { recursive: true });
  sh("git init -q -b main . && git config user.email dev@example.com && git config user.name Dev");
  const w = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  w("package.json", JSON.stringify({ name: "demo-app", version: "1.0.0", scripts: { dev: "bun run server.ts" } }, null, 2) + "\n");
  w("README.md", "# demo-app\n\nA tiny server used to try the UI.\n\n- `bun run dev` starts it\n");
  w(
    "src/server.ts",
    `import { serve } from "bun";\nimport { greet } from "./greet";\n\nconst port = Number(process.env.PORT ?? 3000);\n\nserve({\n  port,\n  fetch(req) {\n    const url = new URL(req.url);\n    if (url.pathname === "/health") return Response.json({ ok: true });\n    return new Response(greet(url.searchParams.get("name") ?? "world"));\n  },\n});\n\nconsole.log(\`listening on :\${port}\`);\n`,
  );
  w("src/greet.ts", `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`);
  w("src/utils/math.ts", `export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\nexport const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);\n`);
  w("styles/app.css", `:root { --accent: #45d4e6; }\nbody { font-family: system-ui; margin: 0; }\n`);
  w(".gitignore", "node_modules\ndist\n*.log\n");
  sh("git add -A && git commit -q -m 'Initial commit' && echo 'export const VERSION = \"1.0.0\";' > src/version.ts && git add -A && git commit -q -m 'Add version constant' && git checkout -q -b feature/greeting");
  w("src/greet.ts", `export function greet(name: string, punctuation = "!"): string {\n  return \`Hello, \${name}\${punctuation}\`;\n}\n`);
  sh("git add -A && git commit -q -m 'Allow custom punctuation in greet' && git checkout -q main");
  // Working-tree changes for the git panel.
  w("src/greet.ts", `export function greet(name: string): string {\n  const trimmed = name.trim() || "world";\n  return \`Hello, \${trimmed}!\`;\n}\n`);
  w("src/utils/strings.ts", `export const upper = (s: string) => s.toUpperCase();\n`);
}

export async function withUi<T>(fn: (env: UiEnv) => Promise<T>, opts: { viewport?: { width: number; height: number }; theme?: "dark" | "light"; env?: Record<string, string>; chromeArgs?: string[] } = {}): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trb-ui-home-"));
  const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trb-ui-repo-")), "demo-app");
  sampleRepo(repo);
  const env = { ...process.env, TRB_HOME: home, TRB_FAKE_ENGINE: path.join(ROOT, "tests", "fixtures", "fake-engine"), TRB_NO_AUTOSTART: "", ...opts.env };
  const trb = (...args: string[]) => {
    const r = spawnSync("bun", ["run", MAIN, ...args], { env, encoding: "utf-8", cwd: repo, timeout: 30_000 });
    return { stdout: r.stdout, stderr: r.stderr, code: r.status };
  };
  let browser: Browser | null = null;
  try {
    const started = trb("daemon", "start");
    if (started.code !== 0) throw new Error(`daemon failed: ${started.stderr}`);
    const info = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf-8"));
    const ui = trb("ui", "--no-open");
    const signIn = /(http:\/\/127\.0\.0\.1:\d+\/_auth\?[^\s]+)/.exec(ui.stdout)?.[1];
    const workspaceId = /\/w\/(w_[A-Za-z0-9]+)/.exec(ui.stdout)?.[1];
    if (!signIn || !workspaceId) throw new Error(`trb ui printed no sign-in link:\n${ui.stdout}\n${ui.stderr}`);

    browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: opts.chromeArgs });
    const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1480, height: 900 }, deviceScaleFactor: 1 });
    if (opts.theme) await context.addInitScript((t) => localStorage.setItem("trb.theme", t), opts.theme);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", e.message));
    page.on("console", (m) => m.type() === "error" && console.error("[console.error]", m.text().slice(0, 300)));
    await page.goto(signIn);
    await page.waitForLoadState("networkidle");
    const shot = async (name: string, o: { fullPage?: boolean } = {}) => {
      const file = path.join("/tmp/trb-shots", `${name}.png`);
      await page.screenshot({ path: file, fullPage: o.fullPage });
      return file;
    };
    return await fn({ page, browser, home, repo, workspaceId, url: info.url, trb, shot });
  } finally {
    // A wedged Chrome must not hold the run (and the real error) hostage.
    await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 10_000))]);
    trb("daemon", "stop");
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [cmd, out] = process.argv.slice(2);
  if (cmd === "shot") {
    await withUi(async ({ page, shot }) => {
      await page.waitForTimeout(500);
      console.log(await shot(out ?? "home"));
    });
  }
}
