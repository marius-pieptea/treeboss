/**
 * `trb product …` and `trb portfolio`: products (the things you ship) and the one-screen view of all of them.
 *
 *   trb product ls [--json]                                    every product: status, repos, spend
 *   trb product new "<name>" [-D "<text>"] [-s status] [-b usd]
 *   trb product show <id|slug> [--json]                        repos, spend (all time, this month, last 7 days)
 *   trb product attach <id|slug> [-w w_…] [-r web|api|mobile|worker|other]    default workspace: this directory
 *   trb product detach <id|slug> [-w w_…]
 *   trb product set-status <id|slug> <idea|building|staging|live|paused|archived>
 *   trb product budget <id|slug> <usd a month | none>
 *   trb portfolio [--json]                                     every product with roadmap progress, last verify, spend vs budget
 */
import path from "path";
import { opts } from "../args";
import { api } from "../client";
import { c, die, money, printJson, table } from "../fmt";

interface Repo {
  workspace_id: string;
  role: string;
  path: string;
  name: string;
}
interface Spend {
  allTime: number;
  thisMonth: number;
  last7Days: number;
  budgetUsdMonth: number | null;
  overBudget: boolean;
}
interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  budget_usd_month: number | null;
  repos: Repo[];
  spend: Spend | null;
}
interface PortfolioProduct extends Product {
  repos: Array<Repo & { progress: { items: number; shipped: number; tasksDone: number; tasksTotal: number } | null; verify: { state: "passed" | "failed"; finished_at: string | null } | null; spend: number }>;
  progress: { items: number; shipped: number; tasksDone: number; tasksTotal: number };
}

const USAGE = `Usage: trb product <ls|new|show|attach|detach|set-status|budget> …
  trb product ls [--json]
  trb product new "<name>" [-D "<text>"] [-s idea|building|staging|live|paused|archived] [-b usd]
  trb product show <id|slug> [--json]
  trb product attach <id|slug> [-w w_…] [-r web|api|mobile|worker|other]
  trb product detach <id|slug> [-w w_…]
  trb product set-status <id|slug> <status>
  trb product budget <id|slug> <usd a month | none>`;

const STATUS_COLOR: Record<string, (s: string) => string> = { live: c.green, building: c.cyan, staging: c.yellow, paused: c.gray, archived: c.gray };

/** `money` prints zero as $0.0000; show it as $0. */
const usd = (n: number): string => (n === 0 ? "$0" : money(n));

const budgetText = (spend: Spend | null): string => {
  if (!spend) return "";
  if (spend.budgetUsdMonth === null) return `${usd(spend.thisMonth)} this month, no budget`;
  const text = `${usd(spend.thisMonth)} of ${money(spend.budgetUsdMonth)} this month`;
  return spend.overBudget ? c.red(`${text}, over budget`) : text;
};

/** The workspace this directory belongs to, registered on first use (as `trb roadmap` does). */
async function workspaceHere(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

const enc = (ref: string): string => encodeURIComponent(ref);

export async function cmdProduct(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    description: { type: "string", short: "D" },
    status: { type: "string", short: "s" },
    budget: { type: "string", short: "b" },
    workspace: { type: "string", short: "w" },
    role: { type: "string", short: "r" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "ls";
  const ref = positionals[1] ?? "";

  switch (sub) {
    case "ls":
    case "list": {
      const { products } = await api<{ products: Product[] }>("GET", "/api/products");
      if (values.json) return printJson({ products });
      if (!products.length) {
        console.log(c.dim("no products yet: trb product new \"<name>\""));
        return 0;
      }
      const rows = products.map((p) => [
        c.bold(p.name),
        c.dim(p.slug),
        (STATUS_COLOR[p.status] ?? ((s: string) => s))(p.status),
        `${p.repos.length} repo${p.repos.length === 1 ? "" : "s"}`,
        budgetText(p.spend),
      ]);
      console.log(table(rows, ["NAME", "SLUG", "STATUS", "REPOS", "SPEND"]));
      return 0;
    }

    case "new":
    case "create": {
      const name = positionals.slice(1).join(" ").trim();
      if (!name) die('Usage: trb product new "<name>" [-D "<text>"] [-s status] [-b usd]');
      const { product } = await api<{ product: Product }>("POST", "/api/products", {
        name,
        description: values.description,
        status: values.status,
        budget_usd_month: values.budget,
      });
      if (values.json) return printJson({ product });
      console.log(`created ${product.name} (${product.slug}, ${product.id})`);
      return 0;
    }

    case "show": {
      if (!ref) die("Usage: trb product show <id|slug> [--json]");
      const { product } = await api<{ product: Product }>("GET", `/api/products/${enc(ref)}`);
      if (values.json) return printJson({ product });
      console.log(`${c.bold(product.name)} ${c.dim(`${product.slug} · ${product.id}`)}`);
      console.log(`status    ${product.status}`);
      if (product.description) console.log(`about     ${product.description}`);
      if (product.spend) {
        const s = product.spend;
        console.log(`budget    ${s.budgetUsdMonth === null ? c.dim("none") : `${money(s.budgetUsdMonth)} a month`}`);
        console.log(`spend     ${usd(s.thisMonth)} this month${s.overBudget ? c.red(" (over budget)") : ""} · ${usd(s.last7Days)} last 7 days · ${usd(s.allTime)} all time`);
      }
      console.log(`\n${c.bold("repos")}${product.repos.length ? "" : c.dim("  none yet: trb product attach " + product.slug)}`);
      for (const r of product.repos) console.log(`  ${r.workspace_id}  ${r.role.padEnd(7)} ${r.name}  ${c.dim(r.path)}`);
      return 0;
    }

    case "attach": {
      if (!ref) die("Usage: trb product attach <id|slug> [-w w_…] [-r web|api|mobile|worker|other]");
      const workspace = values.workspace ?? (await workspaceHere());
      const { product } = await api<{ product: Product }>("POST", `/api/products/${enc(ref)}/repos`, { workspace, role: values.role ?? "other" });
      if (values.json) return printJson({ product });
      console.log(`attached ${workspace} to ${product.name} (${values.role ?? "other"})`);
      return 0;
    }

    case "detach": {
      if (!ref) die("Usage: trb product detach <id|slug> [-w w_…]");
      const workspace = values.workspace ?? (await workspaceHere());
      const { product } = await api<{ product: Product }>("DELETE", `/api/products/${enc(ref)}/repos?workspace=${enc(workspace)}`);
      if (values.json) return printJson({ product });
      console.log(`detached ${workspace} from ${product.name}`);
      return 0;
    }

    case "set-status": {
      const status = positionals[2];
      if (!ref || !status) die("Usage: trb product set-status <id|slug> <idea|building|staging|live|paused|archived>");
      const { product } = await api<{ product: Product }>("PATCH", `/api/products/${enc(ref)}`, { status });
      if (values.json) return printJson({ product });
      console.log(`${product.name} is ${product.status}`);
      return 0;
    }

    case "budget": {
      const amount = positionals[2];
      if (!ref || amount === undefined) die("Usage: trb product budget <id|slug> <usd a month | none>");
      const clear = amount === "none" || amount === "";
      const { product } = await api<{ product: Product }>("PATCH", `/api/products/${enc(ref)}`, { budget_usd_month: clear ? null : amount });
      if (values.json) return printJson({ product });
      console.log(product.budget_usd_month === null ? `${product.name}: no budget` : `${product.name}: budget ${money(product.budget_usd_month)} a month`);
      return 0;
    }

    default:
      die(USAGE);
  }
}

/** `trb portfolio`: every product on one screen. */
export async function cmdPortfolio(argv: string[]): Promise<number> {
  const { values } = opts(argv, { json: { type: "boolean" } });
  const { products } = await api<{ products: PortfolioProduct[] }>("GET", "/api/portfolio");
  if (values.json) return printJson({ products });
  if (!products.length) {
    console.log(c.dim("no products yet: trb product new \"<name>\""));
    return 0;
  }
  for (const p of products) {
    const status = (STATUS_COLOR[p.status] ?? ((s: string) => s))(p.status);
    console.log(`\n${c.bold(p.name)} ${c.dim(p.slug)}  ${status}  ${c.dim(`${p.progress.shipped}/${p.progress.items} shipped`)}`);
    console.log(`  ${budgetText(p.spend) || c.dim("no spend yet")}`);
    if (!p.repos.length) console.log(c.dim("  no repos attached"));
    const rows = p.repos.map((r) => {
      const roadmap = r.progress ? `${r.progress.shipped}/${r.progress.items} shipped` : c.dim("no roadmap");
      const verify = !r.verify ? c.dim("no verify run") : r.verify.state === "passed" ? c.green("verify passed") : c.red("verify failed");
      return [r.role, r.name, roadmap, verify, usd(r.spend)];
    });
    if (rows.length) console.log(table(rows).replace(/^/gm, "  "));
  }
  return 0;
}
