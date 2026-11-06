import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { detect, envKeys, parseProcfile } from "../src/devserver/detect";
import { canBind, pickPort, portArgs, portFromOutput, withPortArgs } from "../src/devserver/ports";
import { makeDir } from "./helpers";

const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

describe("detect", () => {
  test("package.json scripts, package manager from the lockfile, database scripts apart", () => {
    const d = makeDir();
    write(d, "package.json", JSON.stringify({ scripts: { dev: "vite", build: "vite build", start: "node server.js", "db:migrate": "prisma migrate dev", seed: "bun seed.ts", test: "bun test" } }));
    write(d, "bun.lock", "");
    const r = detect(d);
    expect(r.packageManager).toBe("bun");
    expect(r.services.map((s) => s.command)).toEqual(["bun run dev", "bun run start"]);
    expect(r.db.map((s) => s.id)).toEqual(["db:migrate", "seed"]);
    expect(r.db.every((s) => s.kind === "task")).toBe(true);
  });

  test("yarn and pnpm spell the command their own way", () => {
    const y = makeDir();
    write(y, "package.json", JSON.stringify({ scripts: { dev: "next dev" } }));
    write(y, "yarn.lock", "");
    expect(detect(y).services[0].command).toBe("yarn dev");
    const p = makeDir();
    write(p, "package.json", JSON.stringify({ scripts: { dev: "next dev" } }));
    write(p, "pnpm-lock.yaml", "");
    expect(detect(p).services[0].command).toBe("pnpm run dev");
  });

  test("Procfile entries and monorepo apps", () => {
    const d = makeDir();
    write(d, "Procfile", "# comment\nweb: node server.js\nworker: node worker.js\n");
    write(d, "apps/site/package.json", JSON.stringify({ scripts: { dev: "astro dev" } }));
    const r = detect(d);
    expect(r.services.map((s) => s.id).sort()).toEqual(["apps/site:dev", "proc:web", "proc:worker"]);
    expect(r.services.find((s) => s.id === "apps/site:dev")!.dir).toBe("apps/site");
  });

  test("nothing to run is not an error", () => {
    expect(detect(makeDir())).toEqual({ packageManager: null, services: [], db: [], envFiles: [] });
  });

  test("env files are reduced to keys: values never appear", () => {
    const d = makeDir();
    write(d, "package.json", "{}");
    write(d, ".env", 'API_KEY=sk-super-secret-value\nexport DB_URL="postgres://u:p@h/db"\n# NOPE=1\nEMPTY=\n');
    write(d, ".env.local", "TOKEN=abc123xyz\n");
    const r = detect(d);
    expect(r.envFiles).toEqual([
      { file: ".env", keys: ["API_KEY", "DB_URL", "EMPTY"] },
      { file: ".env.local", keys: ["TOKEN"] },
    ]);
    const all = JSON.stringify(r);
    for (const secret of ["sk-super-secret-value", "postgres://", "abc123xyz"]) expect(all).not.toContain(secret);
  });

  test("envKeys / parseProcfile helpers", () => {
    expect(envKeys("A=1\nA=2\nB = 3\n 1BAD=4")).toEqual(["A", "B"]);
    expect(parseProcfile("web: bun run dev\n#x: y\nbad line")).toEqual([{ name: "web", command: "bun run dev" }]);
  });
});

describe("ports", () => {
  test("pickPort is stable per directory, skips taken ports and busy ones", async () => {
    const a = await pickPort("/tmp/a");
    expect(await pickPort("/tmp/a")).toBe(a);
    expect(await pickPort("/tmp/a", [a])).not.toBe(a);
    const b = await pickPort("/tmp/a", [], async (p) => p !== a);
    expect(b).not.toBe(a);
  });

  test("canBind is false for a port in use", async () => {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    expect(await canBind(s.port as number)).toBe(false);
    s.stop(true);
  });

  test("port flags only for a plain call of a known tool", () => {
    expect(portArgs("vite", 4100)).toEqual(["--port", "4100", "--strictPort"]);
    expect(portArgs("next dev", 4100)).toEqual(["-p", "4100"]);
    expect(portArgs("concurrently \"vite\" \"node api\"", 4100)).toEqual([]);
    expect(portArgs("node server.js", 4100)).toEqual([]);
    expect(withPortArgs("npm run dev", "npm", ["--port", "1"])).toBe("npm run dev -- --port 1");
    expect(withPortArgs("bun run dev", "bun", ["--port", "1"])).toBe("bun run dev --port 1");
  });

  test("a port is learned from output", () => {
    expect(portFromOutput("  ➜  Local:   http://localhost:5173/")).toBe(5173);
    expect(portFromOutput("listening on http://127.0.0.1:8080")).toBe(8080);
    expect(portFromOutput("no url here")).toBeNull();
  });
});
