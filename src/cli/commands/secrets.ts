/**
 * `trb secret` and `trb env`: a workspace's environments and encrypted secrets from a terminal. The project is the
 * current directory. Values are never printed; `set` reads one from stdin when it is not given as an argument, so it
 * stays out of shell history.
 *
 *   trb env ls [--json]
 *   trb env add <name> [--url U]             ("" clears the URL)
 *   trb env rm <name>                        a custom environment and its secrets
 *   trb secret ls [--env dev] [--json]       names and times
 *   trb secret set <KEY> [VALUE] [--env dev]
 *   trb secret unset <KEY> [--env dev]
 *   trb secret import <file.env> [--env dev] a file inside the project
 *   trb secret export [--env dev] [--file .env.dev] [--force]   writes the file with mode 0600
 */
import path from "path";
import { opts } from "../args";
import { api } from "../client";
import { ago, c, die, printJson, printLine, table } from "../fmt";

interface Env {
  name: string;
  url: string | null;
  builtin: boolean;
  secrets: number;
}

const USAGE_ENV = `Usage: trb env <ls|add|rm>
  trb env ls [--json]
  trb env add <name> [--url U]
  trb env rm <name>`;

const USAGE_SECRET = `Usage: trb secret <ls|set|unset|import|export> …
  trb secret ls [--env dev] [--json]
  trb secret set <KEY> [VALUE] [--env dev]   (VALUE is read from stdin when omitted)
  trb secret unset <KEY> [--env dev]
  trb secret import <file.env> [--env dev]
  trb secret export [--env dev] [--file .env.dev] [--force]`;

async function workspaceId(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

async function stdinText(): Promise<string> {
  if (process.stdin.isTTY) die("Give the value after the name, or pipe it in: printf '%s' \"$VALUE\" | trb secret set KEY");
  return (await Bun.stdin.text()).replace(/\r?\n$/, "");
}

export async function cmdEnv(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    url: { type: "string" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "ls";
  const base = `/api/workspaces/${await workspaceId()}/envs`;

  switch (sub) {
    case "ls":
    case "list": {
      const { envs } = await api<{ envs: Env[] }>("GET", base);
      if (values.json) return printJson(envs);
      console.log(
        table(
          envs.map((e) => [e.name, e.url ?? c.dim("—"), `${e.secrets} secret${e.secrets === 1 ? "" : "s"}`, e.builtin ? c.dim("built in") : ""]),
          ["ENV", "URL", "SECRETS", ""],
        ),
      );
      return 0;
    }
    case "add": {
      const name = positionals[1] ?? die(USAGE_ENV);
      await api("POST", base, { name, url: values.url ?? null });
      return printLine(`${c.green("✓")} environment ${name}${values.url ? ` → ${values.url}` : ""}`);
    }
    case "rm":
    case "remove": {
      const name = positionals[1] ?? die(USAGE_ENV);
      const r = await api<{ removedSecrets: number }>("DELETE", `${base}/${encodeURIComponent(name)}`);
      return printLine(`removed ${name} and its ${r.removedSecrets} secret${r.removedSecrets === 1 ? "" : "s"}`);
    }
    default:
      return die(USAGE_ENV);
  }
}

export async function cmdSecret(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    env: { type: "string", short: "e" },
    file: { type: "string", short: "f" },
    force: { type: "boolean" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "ls";
  const env = values.env || "dev";
  const base = `/api/workspaces/${await workspaceId()}`;
  const q = `?env=${encodeURIComponent(env)}`;

  switch (sub) {
    case "ls":
    case "list": {
      const r = await api<{ env: string; keys: Array<{ key: string; updatedAt: string }> }>("GET", `${base}/secrets${q}`);
      if (values.json) return printJson(r);
      if (!r.keys.length) return printLine(`No secrets in ${env}. Add one with: trb secret set KEY --env ${env}`);
      console.log(table(r.keys.map((k) => [k.key, c.dim(ago(k.updatedAt))]), [`SECRETS (${env})`, "UPDATED"]));
      return 0;
    }
    case "set": {
      const key = positionals[1] ?? die(USAGE_SECRET);
      const value = positionals[2] ?? (await stdinText());
      await api("PUT", `${base}/secrets/${encodeURIComponent(key)}${q}`, { value });
      return printLine(`${c.green("✓")} ${key} set in ${env}`);
    }
    case "unset":
    case "rm": {
      const key = positionals[1] ?? die(USAGE_SECRET);
      const r = await api<{ removed: boolean }>("DELETE", `${base}/secrets/${encodeURIComponent(key)}${q}`);
      return printLine(r.removed ? `removed ${key} from ${env}` : `${key} was not set in ${env}`);
    }
    case "import": {
      const file = positionals[1] ?? die(USAGE_SECRET);
      const r = await api<{ keys: string[]; skipped: number }>("POST", `${base}/secrets/import`, { env, path: file });
      const skipped = r.skipped ? `, ${r.skipped} line${r.skipped === 1 ? "" : "s"} skipped` : "";
      return printLine(`${c.green("✓")} imported ${r.keys.length} into ${env}${skipped}`);
    }
    case "export": {
      const r = await api<{ path: string; count: number }>("POST", `${base}/secrets/export`, { env, path: values.file ?? null, force: values.force === true });
      return printLine(`${c.green("✓")} wrote ${r.count} secret${r.count === 1 ? "" : "s"} from ${env} to ${r.path} (mode 0600). Keep it out of git.`);
    }
    default:
      return die(USAGE_SECRET);
  }
}
