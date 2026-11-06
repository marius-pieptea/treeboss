/**
 * REA (https://github.com/morluto/rea, MIT): a third-party MCP server for reverse engineering: native binaries,
 * Electron and JS apps, APKs, WASM and websites. trb does not bundle or wrap it. It is on by default (`rea_mcp`;
 * `trb config set rea_mcp off` turns it off), and then it is offered to sessions as one more MCP server named `rea`, next to trb's own evidence tools,
 * which cover the web case natively; REA is for the targets those cannot reach.
 *
 * It runs through `npx -y rea-agents@<pinned> mcp`, so turning it on makes the engine download and run that
 * npm package, so with the default setting the engine downloads and runs it on first use. Once npm has that pinned
 * version in its cache, each turn runs it straight through `node` instead, which skips the npx process (about 90 MB a turn).
 * The version is pinned here and moves only with a trb release. REA's native analysis needs
 * Ghidra, Hopper or IDA installed separately; it says so itself when one is missing.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { getSetting } from "../settings";

export const REA_NAME = "rea";
/** Homebrew's prefixes: /opt/homebrew on Apple silicon, /usr/local on Intel. */
export const BREW_PREFIXES = ["/opt/homebrew", "/usr/local"];
export const REA_VERSION = "6.4.0";
export const REA_HINT = "REA is available (the rea MCP server): use it to inspect software you have no source for (binaries, Electron apps, APKs, WASM). It returns findings with their evidence and limits: report them the same way. When the evidence_* tools exist, start an investigation first, save each REA result that matters with evidence_save_result (keep its evidence and limits), and record each feature or UI design it shows as evidence_finding.";

export interface ReaLaunch {
  command: string;
  args: string[];
  /** `override` when rea_command is set, `cached` for the pinned package already in npm's cache run by node, `npx` otherwise. */
  source: "override" | "cached" | "npx";
}

export function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `<prefix>/bin/<name>` for the first prefix that has it executable. A GUI-launched daemon may not have Homebrew on PATH. */
export function prefixBin(name: string, prefixes: string[] = BREW_PREFIXES): string | null {
  return prefixes.map((p) => path.join(p, "bin", name)).find(isExecutable) ?? null;
}

/**
 * The npm cache folders npx keeps its installs in: `_npx/<hash>/node_modules/<package>`. `npm_config_cache` wins when set,
 * else npm's default for this platform.
 */
export function npxCacheRoots(): string[] {
  const cache = process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE;
  if (cache) return [path.join(cache, "_npx")];
  return [process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx") : path.join(os.homedir(), ".npm", "_npx")];
}

/**
 * The entry script of the pinned REA package when npx has already installed it (`npx -y` keeps that install in its cache).
 * Null when no cached install of exactly REA_VERSION has one.
 */
export function cachedReaEntry(roots: string[] = npxCacheRoots()): string | null {
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const pkgDir = path.join(root, dir, "node_modules", "rea-agents");
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version?: unknown };
        const entry = path.join(pkgDir, "scripts", "rea.mjs");
        if (pkg.version === REA_VERSION && fs.existsSync(entry)) return entry;
      } catch {
        // Not an install of rea-agents: skip it.
      }
    }
  }
  return null;
}

/**
 * How to start REA, or null when it cannot be started (no npx and no override). `which` and `prefixes` are injectable so
 * tests can run against a fake PATH and a fake Homebrew prefix. The npx found in a Homebrew prefix is used when PATH lacks it.
 * With node and a cached install of the pinned version, REA runs as `node <entry> mcp` instead: the same entry npx would run,
 * without the npx process in front of it.
 */
export function reaLaunch(which: (bin: string) => string | null = (bin) => Bun.which(bin), prefixes: string[] = BREW_PREFIXES, caches: string[] = npxCacheRoots()): ReaLaunch | null {
  const custom = getSetting("rea_command").trim();
  if (custom) {
    const [command, ...args] = custom.split(/\s+/);
    return { command: command!, args, source: "override" };
  }
  const node = which("node") ?? prefixBin("node", prefixes);
  const entry = node ? cachedReaEntry(caches) : null;
  if (node && entry) return { command: node, args: [entry, "mcp"], source: "cached" };
  const npx = which("npx") ?? prefixBin("npx", prefixes);
  return npx ? { command: npx, args: ["-y", `rea-agents@${REA_VERSION}`, "mcp"], source: "npx" } : null;
}

/** Whether sessions should be handed the rea server: the setting is on and it can be started. */
export function reaEnabled(): boolean {
  return getSetting("rea_mcp") === "on" && reaLaunch() !== null;
}
