/** Environments and encrypted secrets: the cipher, the store, .env files, the dev-server injection and the HTTP routes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { _resetRuns, childEnv, readLogs, startService, stopAllRuns } from "../src/devserver/manager";
import { HttpError, makeCtx } from "../src/daemon/http";
import { secretsRoutes } from "../src/daemon/routes/secrets";
import { keyFile, open, seal } from "../src/secrets/crypto";
import { formatDotenv, parseDotenv } from "../src/secrets/dotenv";
import { addEnv, exportDotenv, importDotenv, listEnvs, listSecretKeys, removeEnv, resolveEnv, setSecret, unsetSecret } from "../src/secrets/store";
import { UserError } from "../src/util";
import { Workspaces } from "../src/workspaces";
import { makeDir } from "./helpers";

const posix = process.platform !== "win32";
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 40));
  if (!fn()) throw new Error("timed out");
};

describe("cipher", () => {
  test("round-trips a value and keeps the plaintext out of the sealed form", () => {
    const sealed = seal("hunter2", "aad");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("hunter2");
    expect(open(sealed, "aad")).toBe("hunter2");
  });

  test("a different associated data does not open, and the error does not echo the value", () => {
    const sealed = seal("hunter2", "aad");
    expect(() => open(sealed, "elsewhere")).toThrow(/could not be decrypted/);
    try {
      open(sealed, "elsewhere");
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
  });

  test("altered ciphertext does not open", () => {
    const raw = Buffer.from(seal("hunter2", "aad").slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => open(`v1:${raw.toString("base64")}`, "aad")).toThrow(/could not be decrypted/);
  });

  test("the master key is 32 bytes, created once, and reused", () => {
    seal("first", "x");
    const file = keyFile();
    const before = fs.readFileSync(file, "utf-8");
    expect(Buffer.from(before.trim(), "base64").length).toBe(32);
    seal("second", "x");
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    if (posix) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("dotenv text", () => {
  test("reads comments, export prefixes, quotes, escapes and inline comments; skips non-assignments", () => {
    const text = ['# a comment', "export API_URL=https://x.test/a # trailing", 'TOKEN="line1\\nline2 \\"q\\""', "PLAIN='no $expansion \\n'", "EMPTY=", "not an assignment"].join("\n");
    const { entries, skipped } = parseDotenv(text);
    expect(Object.fromEntries(entries.map((e) => [e.key, e.value]))).toEqual({
      API_URL: "https://x.test/a",
      TOKEN: 'line1\nline2 "q"',
      PLAIN: "no $expansion \\n",
      EMPTY: "",
    });
    expect(skipped).toBe(1);
  });

  test("format then parse gives back the same values", () => {
    const values = ["a b", 'x"y', "multi\nline", "back\\slash", "", "plain-1.2/3:4@5", "tab\there"];
    const entries = values.map((value, i) => ({ key: `K${i}`, value }));
    const { entries: back } = parseDotenv(formatDotenv(entries));
    expect(back).toEqual(entries);
  });
});

describe("environments and secrets", () => {
  let id: string;
  let other: string;
  beforeAll(() => {
    id = Workspaces.open(makeDir(), "store-a").id;
    other = Workspaces.open(makeDir(), "store-b").id;
  });

  test("the three built-in environments are there before anything is added", () => {
    expect(listEnvs(id).map((e) => e.name)).toEqual(["dev", "staging", "prod"]);
  });

  test("a custom environment is added with its URL, lowercased, and a bad URL is refused", () => {
    expect(addEnv(id, "QA", "https://qa.example.test").name).toBe("qa");
    expect(listEnvs(id).find((e) => e.name === "qa")?.url).toBe("https://qa.example.test");
    expect(() => addEnv(id, "x", "ftp://nope.test")).toThrow(/http:\/\/ or https:\/\//);
    expect(() => addEnv(id, "Bad Name")).toThrow(UserError);
  });

  test("a secret is stored as ciphertext and resolves to its value on the server side", () => {
    setSecret(id, "dev", "DATABASE_URL", "postgres://u:pw@h/db");
    const row = db().prepare("SELECT value_enc FROM secrets WHERE workspace_id = ? AND key = ?").get(id, "DATABASE_URL") as { value_enc: string };
    expect(row.value_enc).not.toContain("pw@h");
    expect(resolveEnv(id, "dev")).toEqual({ DATABASE_URL: "postgres://u:pw@h/db" });
  });

  test("the key list carries names and times, never values", () => {
    const keys = listSecretKeys(id, "dev");
    expect(keys).toEqual([{ key: "DATABASE_URL", updatedAt: expect.any(String) }]);
    expect(JSON.stringify(keys)).not.toContain("postgres");
  });

  test("workspaces do not see each other's secrets", () => {
    expect(resolveEnv(other, "dev")).toEqual({});
    expect(listSecretKeys(other, "dev")).toEqual([]);
  });

  test("a secret needs its environment to exist, and a valid name", () => {
    expect(() => setSecret(id, "nowhere", "K", "v")).toThrow(/no environment "nowhere"/);
    expect(() => setSecret(id, "dev", "1BAD", "v")).toThrow(UserError);
    expect(() => setSecret(id, "dev", "HAS SPACE", "v")).toThrow(UserError);
    expect(() => setSecret(id, "dev", "OK", "x".repeat(70 * 1024))).toThrow(/64 KB/);
  });

  test("a value moved to another name does not open", () => {
    setSecret(id, "dev", "MOVED", "moved-value");
    db().prepare("UPDATE secrets SET key = 'RENAMED' WHERE workspace_id = ? AND key = 'MOVED'").run(id);
    expect(() => resolveEnv(id, "dev")).toThrow(/could not be decrypted/);
    expect(unsetSecret(id, "dev", "RENAMED")).toBe(true);
    expect(unsetSecret(id, "dev", "RENAMED")).toBe(false);
  });

  test("a custom environment is removed with its secrets; a built-in one is not removable", () => {
    setSecret(id, "qa", "API_KEY", "sk-1");
    expect(removeEnv(id, "qa")).toEqual({ removedSecrets: 1 });
    expect(listEnvs(id).some((e) => e.name === "qa")).toBe(false);
    expect(() => removeEnv(id, "prod")).toThrow(/built in/);
    expect(() => removeEnv(id, "qa")).toThrow(/no environment/);
  });
});

describe(".env import and export", () => {
  let dir: string;
  let id: string;
  beforeAll(() => {
    dir = makeDir();
    id = Workspaces.open(dir, "dotenv-ws").id;
  });

  test("importing reads a file inside the workspace, keeps other keys, and counts skipped lines", () => {
    fs.writeFileSync(path.join(dir, ".env.staging"), 'A=1\nB="two words"\n# c\nnot a pair\n');
    setSecret(id, "staging", "KEEP", "kept");
    expect(importDotenv(id, "staging", ".env.staging")).toEqual({ keys: ["A", "B"], skipped: 1 });
    expect(resolveEnv(id, "staging")).toEqual({ KEEP: "kept", A: "1", B: "two words" });
  });

  test("a path that leaves the workspace is refused, relative or absolute", () => {
    const outside = path.join(makeDir(), "outside.env");
    fs.writeFileSync(outside, "X=1\n");
    expect(() => importDotenv(id, "dev", "../outside.env")).toThrow(/inside the workspace folder/);
    expect(() => importDotenv(id, "dev", outside)).toThrow(/inside the workspace folder/);
    expect(() => exportDotenv(id, "dev", "../leak.env")).toThrow(/inside the workspace folder/);
  });

  test("export writes the environment with mode 0600, refuses to replace unless forced, and reports only the count", () => {
    const res = exportDotenv(id, "staging", "out/staging.env");
    expect(res).toEqual({ path: "out/staging.env", count: 3 });
    const text = fs.readFileSync(path.join(dir, "out/staging.env"), "utf-8");
    expect(text).toContain("A=1");
    expect(text).toContain('B="two words"');
    if (posix) expect(fs.statSync(path.join(dir, "out/staging.env")).mode & 0o777).toBe(0o600);
    expect(() => exportDotenv(id, "staging", "out/staging.env")).toThrow(/already exists/);
    expect(exportDotenv(id, "staging", "out/staging.env", true).count).toBe(3);
  });
});

describe("dev-server injection", () => {
  const dir = makeDir();
  let id: string;
  beforeAll(() => {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { "db:print": 'echo "FROM_STORE=$FROM_STORE|PROCESS_WINS=$PROCESS_WINS|STAGING_ONLY=$STAGING_ONLY|LEAK=$TRB_TOKEN"' } }),
    );
    id = Workspaces.open(dir, "inject-ws").id;
    setSecret(id, "dev", "FROM_STORE", "from-store");
    setSecret(id, "dev", "PROCESS_WINS", "from-store");
    setSecret(id, "dev", "TRB_TOKEN", "leak");
    setSecret(id, "staging", "STAGING_ONLY", "not-for-dev");
    process.env.PROCESS_WINS = "from-process";
  });
  afterAll(async () => {
    delete process.env.PROCESS_WINS;
    await stopAllRuns();
    _resetRuns();
  });

  test("the child gets the dev secrets under the process environment; TRB_TOKEN is never handed on", () => {
    const env = childEnv(null, {}, { FROM_STORE: "from-store", PROCESS_WINS: "from-store", TRB_TOKEN: "leak" });
    expect(env.FROM_STORE).toBe("from-store");
    expect(env.PROCESS_WINS).toBe("from-process");
    expect(env.TRB_TOKEN).toBeUndefined();
  });

  // The spawn runs under /bin/sh, so this one is POSIX-only, like the rest of the run manager's suite.
  test.skipIf(!posix)("a started dev task sees its workspace's dev secrets, and not another environment's", async () => {
    await startService({ rootDir: dir, owner: "w_t", service: "db:print" });
    await until(() => readLogs(dir, "db:print").lines.some((l) => l.text.startsWith("FROM_STORE=")));
    const line = readLogs(dir, "db:print").lines.find((l) => l.text.startsWith("FROM_STORE="))!.text;
    expect(line).toBe("FROM_STORE=from-store|PROCESS_WINS=from-process|STAGING_ONLY=|LEAK=");
  });

  test.skipIf(!posix)("a dev task started outside the workspace folder gets the secrets of the workspace id it is given", async () => {
    const outside = makeDir();
    fs.copyFileSync(path.join(dir, "package.json"), path.join(outside, "package.json"));
    const real = fs.realpathSync(outside);
    await startService({ rootDir: outside, owner: "s_t", service: "db:print", workspaceId: id });
    await until(() => readLogs(real, "db:print").lines.some((l) => l.text.startsWith("FROM_STORE=")));
    const line = readLogs(real, "db:print").lines.find((l) => l.text.startsWith("FROM_STORE="))!.text;
    expect(line).toBe("FROM_STORE=from-store|PROCESS_WINS=from-process|STAGING_ONLY=|LEAK=");
  });
});

describe("HTTP routes", () => {
  let id: string;
  beforeAll(() => {
    id = Workspaces.open(makeDir(), "routes-ws").id;
  });

  /** Calls the route module with the context the server builds. UserError is a 400 and HttpError keeps its status, as in server.ts. */
  async function call(method: string, p: string, body?: Record<string, unknown>): Promise<{ status: number; text: string }> {
    const url = new URL(`http://daemon${p}`);
    const ctx = makeCtx(new Request(url, { method }), url, body ?? {});
    try {
      const res = await secretsRoutes(ctx);
      if (!res) throw new Error(`no route for ${method} ${p}`);
      return { status: res.status, text: await res.text() };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, text: e.message };
      if (e instanceof UserError) return { status: 400, text: e.message };
      throw e;
    }
  }

  test("envs: add, list, remove", async () => {
    const add = await call("POST", `/api/workspaces/${id}/envs`, { name: "qa", url: "https://qa.test" });
    expect(add.status).toBe(201);
    expect(JSON.parse(add.text).envs.map((e: { name: string }) => e.name)).toEqual(["dev", "staging", "prod", "qa"]);
    expect((await call("DELETE", `/api/workspaces/${id}/envs/prod`)).status).toBe(400);
    expect((await call("DELETE", `/api/workspaces/${id}/envs/qa`)).status).toBe(200);
  });

  test("secrets: a value goes in but is never sent back, not in the listing, the write or the export", async () => {
    const put = await call("PUT", `/api/workspaces/${id}/secrets/API_KEY?env=dev`, { value: "sk-route-123" });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain("sk-route-123");
    const list = await call("GET", `/api/workspaces/${id}/secrets?env=dev`);
    expect(JSON.parse(list.text).keys.map((k: { key: string }) => k.key)).toEqual(["API_KEY"]);
    expect(list.text).not.toContain("sk-route-123");
    const exp = await call("POST", `/api/workspaces/${id}/secrets/export`, { env: "dev", path: "exported.env" });
    expect(exp.status).toBe(200);
    expect(exp.text).not.toContain("sk-route-123");
    expect(fs.readFileSync(path.join(Workspaces.get(id)!.path, "exported.env"), "utf-8")).toContain("API_KEY=sk-route-123");
  });

  test("a PUT without text is a 400; a DELETE removes the key; an unknown workspace is a 404", async () => {
    expect((await call("PUT", `/api/workspaces/${id}/secrets/API_KEY?env=dev`, {})).status).toBe(400);
    const del = await call("DELETE", `/api/workspaces/${id}/secrets/API_KEY?env=dev`);
    expect(JSON.parse(del.text).removed).toBe(true);
    expect((await call("GET", "/api/workspaces/w_missing/secrets")).status).toBe(404);
  });

  test("import from a path outside the workspace is refused", async () => {
    const r = await call("POST", `/api/workspaces/${id}/secrets/import`, { env: "dev", path: "/etc/passwd" });
    expect(r.status).toBe(400);
  });
});
