/**
 * Which commands verify a project: typecheck, lint, test, found from the files in the session's directory.
 * Anything detected can be overridden per workspace (see store.ts); this only supplies the default.
 */
import fs from "fs";
import path from "path";

export interface VerifyCommand {
  /** "typecheck", "lint", "test", or a name the operator gave it. */
  name: string;
  cmd: string;
}

const readJson = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
};
const has = (dir: string, ...names: string[]) => names.some((n) => fs.existsSync(path.join(dir, n)));
const read = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
};

/** `npm test` in a fresh project is a placeholder that fails on purpose. */
const placeholder = (script: string) => /no test specified/i.test(script) || /^\s*exit\s+1\s*$/.test(script);

function nodeCommands(dir: string): VerifyCommand[] {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg || typeof pkg !== "object") return [];
  const scripts: Record<string, string> = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const runner = has(dir, "bun.lock", "bun.lockb") ? "bun run" : has(dir, "pnpm-lock.yaml") ? "pnpm run" : has(dir, "yarn.lock") ? "yarn run" : "npm run";
  const out: VerifyCommand[] = [];
  const typecheck = ["typecheck", "type-check", "check-types", "tsc"].find((n) => scripts[n]);
  // An Expo app ships its TypeScript as it is, so tsc runs even when the project has no script for it.
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const expo = "expo" in deps;
  if (typecheck) out.push({ name: "typecheck", cmd: `${runner} ${typecheck}` });
  else if (has(dir, "tsconfig.json") && has(dir, path.join("node_modules", ".bin", "tsc"))) out.push({ name: "typecheck", cmd: "./node_modules/.bin/tsc --noEmit" });
  else if (expo && has(dir, "tsconfig.json")) out.push({ name: "typecheck", cmd: "npx tsc --noEmit" });
  if (scripts.lint) out.push({ name: "lint", cmd: `${runner} lint` });
  if (scripts.test && !placeholder(scripts.test)) out.push({ name: "test", cmd: `${runner} test` });
  // expo-doctor checks the dependency versions against the SDK over the network, so it runs only where the project declares it.
  if (expo && "expo-doctor" in deps) out.push({ name: "doctor", cmd: "npx expo-doctor" });
  return out;
}

function pythonCommands(dir: string): VerifyCommand[] {
  const out: VerifyCommand[] = [];
  const pyproject = read(path.join(dir, "pyproject.toml"));
  if (/\[tool\.ruff/.test(pyproject) || has(dir, "ruff.toml", ".ruff.toml")) out.push({ name: "lint", cmd: "ruff check ." });
  if (/\[tool\.pytest/.test(pyproject) || has(dir, "pytest.ini", "conftest.py") || /\[tool:pytest\]/.test(read(path.join(dir, "setup.cfg"))) || (has(dir, "pyproject.toml") && has(dir, "tests"))) out.push({ name: "test", cmd: "python3 -m pytest -q" });
  return out;
}

/** The project's verify commands in the order they should run: typecheck, lint, test. Empty when none are recognised. */
export function detectVerifyCommands(dir: string): VerifyCommand[] {
  const found: VerifyCommand[] = [];
  found.push(...nodeCommands(dir));
  if (has(dir, "Cargo.toml")) found.push({ name: "typecheck", cmd: "cargo check --quiet" }, { name: "test", cmd: "cargo test --quiet" });
  if (has(dir, "go.mod")) found.push({ name: "lint", cmd: "go vet ./..." }, { name: "test", cmd: "go test ./..." });
  if (has(dir, "pyproject.toml", "pytest.ini", "setup.cfg", "ruff.toml", "conftest.py")) found.push(...pythonCommands(dir));
  const order = ["typecheck", "lint", "test", "doctor"];
  return found.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

/** A list of `{name, cmd}` from untrusted input, or throws a message for the operator. */
export function parseCommands(input: unknown): VerifyCommand[] {
  if (!Array.isArray(input)) throw new Error("commands must be a list of { name, cmd }.");
  if (input.length > 12) throw new Error("At most 12 verify commands.");
  return input.map((c, i) => {
    const cmd = String(c?.cmd ?? "").trim();
    const name = String(c?.name ?? "").trim() || `check ${i + 1}`;
    if (!cmd) throw new Error(`Command ${i + 1} is empty.`);
    if (cmd.length > 2000) throw new Error(`Command ${i + 1} is too long.`);
    return { name: name.slice(0, 40), cmd };
  });
}
