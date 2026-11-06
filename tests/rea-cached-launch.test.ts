/** REA's launch when npx already has the pinned rea-agents in its cache: `node <entry> mcp`, no npx process in front. */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { buildRunMcpConfig } from "../src/mcp/store";
import { REA_VERSION, cachedReaEntry, reaLaunch } from "../src/evidence/rea";
import { makeDir, resetState } from "./helpers";

const realNpmCache = process.env.npm_config_cache;

beforeEach(() => {
  resetState();
});
afterEach(() => {
  if (realNpmCache === undefined) delete process.env.npm_config_cache;
  else process.env.npm_config_cache = realNpmCache;
});

/** `<root>/<hash>/node_modules/rea-agents` as npx leaves it, with the given version and entry script. */
function cachedInstall(root: string, hash: string, version: string, withEntry = true): string {
  const pkg = path.join(root, hash, "node_modules", "rea-agents");
  fs.mkdirSync(path.join(pkg, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "rea-agents", version }));
  if (withEntry) fs.writeFileSync(path.join(pkg, "scripts", "rea.mjs"), "");
  return path.join(pkg, "scripts", "rea.mjs");
}

const NODE = "/usr/bin/node";
const onlyNode = (bin: string) => (bin === "node" ? NODE : null);

describe("cachedReaEntry", () => {
  test("finds the pinned version among npx's installs, and skips other versions, incomplete installs and other folders", () => {
    const root = makeDir();
    cachedInstall(root, "aaaa", "6.5.0");
    cachedInstall(root, "bbbb", REA_VERSION, false);
    fs.mkdirSync(path.join(root, "cccc"), { recursive: true });
    fs.writeFileSync(path.join(root, "cccc", "package.json"), "{ not json");
    const entry = cachedInstall(root, "dddd", REA_VERSION);
    expect(cachedReaEntry([root])).toBe(entry);
  });

  test("null when the roots are missing or hold no install of the pinned version", () => {
    const root = makeDir();
    cachedInstall(root, "aaaa", "6.5.0");
    expect(cachedReaEntry([root])).toBeNull();
    expect(cachedReaEntry([path.join(root, "missing")])).toBeNull();
    expect(cachedReaEntry([])).toBeNull();
  });
});

describe("reaLaunch with a cached install", () => {
  test("node plus the cached pinned entry runs REA directly, with the same arguments npx would pass to it", () => {
    const root = makeDir();
    const entry = cachedInstall(root, "dddd", REA_VERSION);
    expect(reaLaunch(onlyNode, [], [root])).toEqual({ command: NODE, args: [entry, "mcp"], source: "cached" });
  });

  test("without node, or without the cached install, it falls back to npx", () => {
    const root = makeDir();
    cachedInstall(root, "dddd", REA_VERSION);
    const npx = (bin: string) => (bin === "npx" ? "/usr/bin/npx" : null);
    expect(reaLaunch(npx, [], [root])).toEqual({ command: "/usr/bin/npx", args: ["-y", `rea-agents@${REA_VERSION}`, "mcp"], source: "npx" });
    expect(reaLaunch((bin) => (bin === "npx" || bin === "node" ? "/usr/bin/x" : null), [], [makeDir()])?.source).toBe("npx");
  });

  test("the cache root comes from npm_config_cache when set", () => {
    const cache = makeDir();
    const entry = cachedInstall(path.join(cache, "_npx"), "eeee", REA_VERSION);
    process.env.npm_config_cache = cache;
    expect(reaLaunch(onlyNode)).toEqual({ command: NODE, args: [entry, "mcp"], source: "cached" });
  });

  test("buildRunMcpConfig hands the rea server the cached launch when there is one", () => {
    if (!Bun.which("node") || !Bun.which("npx")) return;
    const cache = makeDir();
    const entry = cachedInstall(path.join(cache, "_npx"), "ffff", REA_VERSION);
    process.env.npm_config_cache = cache;
    const rea = buildRunMcpConfig({ sessionId: "s_x", subagents: false, daemonUrl: "http://127.0.0.1:1", token: "t", rea: true }).rea;
    expect(rea).toMatchObject({ type: "stdio", args: [entry, "mcp"] });
    expect(rea?.type === "stdio" && path.basename(rea.command).toLowerCase()).toMatch(/^node(\.exe)?$/);
  });
});
