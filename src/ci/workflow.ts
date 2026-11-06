/**
 * The CI workflow of a workspace: `.github/workflows/ci.yml`, generated from what the project has.
 *
 * Detection reuses src/verify/detect.ts for the typecheck, lint and test commands, and adds the package
 * manager, the other toolchains and whether a Playwright config exists (then an e2e job is added). Every
 * `run:` line comes from that fixed vocabulary, never from file contents. A workflow is written only when
 * asked, and never over an existing file unless `overwrite` is set.
 */
import fs from "fs";
import path from "path";
import { detectVerifyCommands, type VerifyCommand } from "../verify/detect";
import { UserError } from "../util";

export const WORKFLOW_PATH = ".github/workflows/ci.yml";
const PLAYWRIGHT_CONFIGS = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs", "playwright.config.mts", "playwright.config.cts"];
const LOCKFILES = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
const NODE_VERSION = "22";
const PYTHON_VERSION = "3.12";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export interface WorkflowInputs {
  packageManager: PackageManager | null;
  /** The lockfile the install step pins to, or null when the project has none. */
  lockfile: string | null;
  cargo: boolean;
  go: boolean;
  python: boolean;
  /** pyproject.toml declares a [project] to install with pip. */
  pythonProject: boolean;
  requirements: boolean;
  /** The Playwright config file, when there is one (its presence adds an e2e job). A path below the root ("apps/web/playwright.config.ts") makes the Playwright steps run in that folder. */
  playwright: string | null;
  verify: VerifyCommand[];
}

export interface WorkflowPlan {
  /** Workspace-relative path the workflow lives at. */
  path: string;
  exists: boolean;
  yaml: string;
  inputs: WorkflowInputs;
}

const has = (root: string, ...names: string[]) => names.some((n) => fs.existsSync(path.join(root, n)));
const read = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
};

/** What the project has, read from its files. Nothing is run. */
export function detectInputs(root: string): WorkflowInputs {
  const hasNode = has(root, "package.json");
  const lockfile = LOCKFILES.find((f) => has(root, f)) ?? null;
  const packageManager: PackageManager | null = !hasNode
    ? null
    : lockfile?.startsWith("bun.")
      ? "bun"
      : lockfile === "pnpm-lock.yaml"
        ? "pnpm"
        : lockfile === "yarn.lock"
          ? "yarn"
          : "npm";
  const pyproject = read(path.join(root, "pyproject.toml"));
  return {
    packageManager,
    lockfile,
    cargo: has(root, "Cargo.toml"),
    go: has(root, "go.mod"),
    python: has(root, "pyproject.toml", "pytest.ini", "setup.cfg", "ruff.toml", ".ruff.toml", "conftest.py", "requirements.txt"),
    pythonProject: /^\[project\]/m.test(pyproject),
    requirements: has(root, "requirements.txt"),
    playwright: hasNode ? (PLAYWRIGHT_CONFIGS.find((f) => has(root, f)) ?? null) : null,
    verify: detectVerifyCommands(root),
  };
}

/** The install and execute commands for a package manager. */
const PM = {
  bun: { install: (lock: string | null) => (lock ? "bun install --frozen-lockfile" : "bun install"), exec: "bunx" },
  npm: { install: (lock: string | null) => (lock ? "npm ci" : "npm install"), exec: "npx" },
  pnpm: { install: (lock: string | null) => (lock ? "pnpm install --frozen-lockfile" : "pnpm install"), exec: "pnpm exec" },
  yarn: { install: (lock: string | null) => (lock ? "yarn install --frozen-lockfile" : "yarn install"), exec: "yarn" },
} as const;

/** One YAML step. `run` is always a block scalar, so no command text can break the document. */
function step(name: string, body: string[]): string[] {
  return [`      - name: ${name}`, ...body.map((l) => `        ${l}`)];
}
const run = (name: string, cmd: string, cwd?: string): string[] => step(name, ["run: |", `  ${cmd}`, ...(cwd && cwd !== "." ? [`working-directory: ${cwd}`] : [])]);

/** Setup and install for the node toolchain: runtime, cache, dependencies. */
function nodeSetup(pm: PackageManager, lock: string | null): string[] {
  const out: string[] = [];
  const lockHash = lock ? `hashFiles('${lock}')` : "''";
  if (pm === "bun") {
    out.push(...step("Set up Bun", ["uses: oven-sh/setup-bun@v2", "with:", "  bun-version: latest"]));
    out.push(...step("Cache Bun packages", ["uses: actions/cache@v4", "with:", "  path: ~/.bun/install/cache", `  key: bun-\${{ runner.os }}-\${{ ${lockHash} }}`]));
  } else {
    if (pm === "pnpm") out.push(...step("Set up pnpm", ["uses: pnpm/action-setup@v4", "with:", "  version: 9"]));
    out.push(...step("Set up Node", ["uses: actions/setup-node@v4", "with:", `  node-version: '${NODE_VERSION}'`, ...(lock ? [`  cache: ${pm}`] : [])]));
  }
  out.push(...run("Install dependencies", PM[pm].install(lock)));
  return out;
}

/** Setup and cache for the Rust and Go and Python toolchains. */
function otherSetup(inputs: WorkflowInputs): string[] {
  const out: string[] = [];
  if (inputs.cargo) {
    out.push(...step("Set up Rust", ["uses: dtolnay/rust-toolchain@stable"]));
    out.push(...step("Cache Cargo", ["uses: actions/cache@v4", "with:", "  path: |", "    ~/.cargo/registry", "    ~/.cargo/git", "    target", `  key: cargo-\${{ runner.os }}-\${{ hashFiles('Cargo.lock') }}`]));
  }
  if (inputs.go) out.push(...step("Set up Go", ["uses: actions/setup-go@v5", "with:", "  go-version-file: go.mod", "  cache: true"]));
  if (inputs.python) {
    out.push(...step("Set up Python", ["uses: actions/setup-python@v5", "with:", `  python-version: '${PYTHON_VERSION}'`]));
    out.push(...step("Cache pip", ["uses: actions/cache@v4", "with:", "  path: ~/.cache/pip", "  key: pip-${{ runner.os }}-${{ hashFiles('pyproject.toml', 'requirements*.txt') }}"]));
    const installs = ["python -m pip install --upgrade pip", ...(inputs.requirements ? ["python -m pip install -r requirements.txt"] : []), ...(inputs.pythonProject ? ["python -m pip install -e ."] : []), "python -m pip install ruff pytest"];
    out.push(...step("Install Python tools", ["run: |", ...installs.map((c) => `  ${c}`)]));
  }
  return out;
}

const VERIFY_NAMES: Record<string, string> = { typecheck: "Typecheck", lint: "Lint", test: "Test" };

/**
 * The workflow text for the given inputs. Two jobs: `verify` runs every detected command after the toolchains
 * are set up; `e2e` runs Playwright when a config exists. Pull requests and pushes to main start both.
 */
export function renderWorkflow(inputs: WorkflowInputs): string {
  const lines: string[] = [
    "# Generated by `trb ci init`. Edit freely: trb does not overwrite this file unless asked.",
    "name: CI",
    "",
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "  workflow_dispatch:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: ci-${{ github.ref }}",
    "  cancel-in-progress: true",
    "",
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    "    steps:",
    "      - uses: actions/checkout@v4",
  ];
  if (inputs.packageManager) lines.push(...nodeSetup(inputs.packageManager, inputs.lockfile));
  lines.push(...otherSetup(inputs));
  for (const v of inputs.verify) lines.push(...run(VERIFY_NAMES[v.name] ?? v.name, v.cmd));

  if (inputs.playwright && inputs.packageManager) {
    const pm = inputs.packageManager;
    const cwd = path.posix.dirname(inputs.playwright);
    lines.push(
      "",
      "  e2e:",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 30",
      "    steps:",
      "      - uses: actions/checkout@v4",
      ...nodeSetup(pm, inputs.lockfile),
      ...step("Cache Playwright browsers", ["uses: actions/cache@v4", "with:", "  path: ~/.cache/ms-playwright", `  key: playwright-\${{ runner.os }}-\${{ ${inputs.lockfile ? `hashFiles('${inputs.lockfile}')` : "''"} }}`]),
      ...run("Install Playwright browsers", `${PM[pm].exec} playwright install --with-deps chromium`, cwd),
      ...run("Run Playwright tests", `${PM[pm].exec} playwright test`, cwd),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * What the workflow would be for this folder, without writing it. Throws when there is nothing to build a
 * workflow from: a CI that runs no commands would only look green.
 */
export function planWorkflow(root: string): WorkflowPlan {
  const inputs = detectInputs(root);
  if (!inputs.verify.length && !inputs.playwright) {
    throw new UserError("Nothing to build a CI workflow from: no typecheck, lint or test command and no Playwright config were found.");
  }
  return { path: WORKFLOW_PATH, exists: fs.existsSync(path.join(root, WORKFLOW_PATH)), yaml: renderWorkflow(inputs), inputs };
}

/**
 * Write the workflow into the folder. Refuses to replace an existing file unless `overwrite` is set, and refuses
 * a `.github` folder that is a symlink leading out of the folder.
 */
export function writeWorkflow(root: string, o: { overwrite?: boolean } = {}): { path: string; written: true; plan: WorkflowPlan } {
  const plan = planWorkflow(root);
  if (plan.exists && !o.overwrite) throw new UserError(`${WORKFLOW_PATH} already exists. Pass overwrite to replace it.`);
  const dir = path.join(root, path.dirname(WORKFLOW_PATH));
  fs.mkdirSync(dir, { recursive: true });
  const realRoot = fs.realpathSync(root);
  const realDir = fs.realpathSync(dir);
  if (path.relative(realRoot, realDir).startsWith("..")) throw new UserError(".github leads outside the workspace.");
  fs.writeFileSync(path.join(root, WORKFLOW_PATH), plan.yaml, "utf-8");
  return { path: WORKFLOW_PATH, written: true, plan };
}
