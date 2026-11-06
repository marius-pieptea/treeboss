/**
 * Products: one thing the operator ships (a SaaS, an app), made of one or more workspaces (its web, api, mobile
 * and worker repos). The tables are created here, lazily, so db.ts is not touched.
 *
 * A workspace may be attached to several products (a shared library); its spend then counts toward each of them.
 * Deleting a workspace detaches it everywhere (the foreign key cascades).
 */
import fs from "fs";
import { db } from "../db";
import { newId, UserError } from "../util";
import { Workspaces, type Workspace } from "../workspaces";

export const PRODUCT_STATUSES = ["idea", "building", "staging", "live", "paused", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const REPO_ROLES = ["web", "api", "mobile", "worker", "other"] as const;
export type RepoRole = (typeof REPO_ROLES)[number];

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: ProductStatus;
  budget_usd_month: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProductRepo {
  product_id: string;
  workspace_id: string;
  role: RepoRole;
  /** From the workspace row: its folder and name. */
  path: string;
  name: string;
}

export interface ProductInput {
  name: string;
  slug?: string | null;
  description?: string | null;
  status?: string | null;
  budget_usd_month?: number | string | null;
}

let ready = false;
function tables(): void {
  if (ready) return;
  db().exec(`CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idea' CHECK(status IN ('idea','building','staging','live','paused','archived')),
    budget_usd_month REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db().exec(`CREATE TABLE IF NOT EXISTS product_repos (
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'other' CHECK(role IN ('web','api','mobile','worker','other')),
    PRIMARY KEY (product_id, workspace_id)
  )`);
  db().exec(`CREATE INDEX IF NOT EXISTS product_repos_workspace ON product_repos (workspace_id)`);
  ready = true;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export function cleanStatus(value: unknown): ProductStatus {
  const v = String(value ?? "").trim().toLowerCase();
  if (!(PRODUCT_STATUSES as readonly string[]).includes(v)) throw new UserError(`Status must be one of ${PRODUCT_STATUSES.join(", ")}.`);
  return v as ProductStatus;
}

export function cleanRole(value: unknown): RepoRole {
  const v = String(value ?? "other").trim().toLowerCase();
  if (!(REPO_ROLES as readonly string[]).includes(v)) throw new UserError(`Role must be one of ${REPO_ROLES.join(", ")}.`);
  return v as RepoRole;
}

/** A budget in USD a month, or null for "no budget". */
export function cleanBudget(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) throw new UserError("The budget must be a number of dollars a month, zero or more.");
  return Math.round(n * 100) / 100;
}

const slugify = (name: string): string => name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "product";

function uniqueSlug(base: string): string {
  let slug = base;
  for (let n = 2; db().prepare("SELECT 1 FROM products WHERE slug = ?").get(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/* -------------------------------------------------------------------------- */
/* Products                                                                   */
/* -------------------------------------------------------------------------- */

export function listProducts(): Product[] {
  tables();
  return db().prepare("SELECT * FROM products ORDER BY created_at, rowid").all() as Product[];
}

export function getProduct(id: string): Product | null {
  tables();
  return (db().prepare("SELECT * FROM products WHERE id = ?").get(id) as Product | undefined) ?? null;
}

/** A product by id or by slug. */
export function resolveProduct(ref: string): Product | null {
  tables();
  return (db().prepare("SELECT * FROM products WHERE id = ? OR slug = ?").get(ref, ref) as Product | undefined) ?? null;
}

function mustProduct(ref: string): Product {
  const p = resolveProduct(ref);
  if (!p) throw new UserError(`No product "${ref}".`);
  return p;
}

export function createProduct(input: ProductInput): Product {
  tables();
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw new UserError("A product needs a name.");
  const slug = uniqueSlug(input.slug?.trim() ? slugify(input.slug) : slugify(name));
  const id = newId("p");
  db().prepare("INSERT INTO products (id, name, slug, description, status, budget_usd_month) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, slug, String(input.description ?? "").trim().slice(0, 2000), input.status ? cleanStatus(input.status) : "idea", cleanBudget(input.budget_usd_month));
  return getProduct(id)!;
}

export interface ProductPatch {
  name?: string;
  description?: string;
  status?: string;
  budget_usd_month?: number | string | null;
}

export function updateProduct(ref: string, patch: ProductPatch): Product {
  const cur = mustProduct(ref);
  const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 80) : cur.name;
  if (!name) throw new UserError("A product needs a name.");
  const description = patch.description !== undefined ? String(patch.description).trim().slice(0, 2000) : cur.description;
  const status = patch.status !== undefined ? cleanStatus(patch.status) : cur.status;
  const budget = patch.budget_usd_month !== undefined ? cleanBudget(patch.budget_usd_month) : cur.budget_usd_month;
  db().prepare("UPDATE products SET name = ?, description = ?, status = ?, budget_usd_month = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(name, description, status, budget, cur.id);
  return getProduct(cur.id)!;
}

/** Removes the product and its repo links. The workspaces themselves stay. */
export function deleteProduct(ref: string): boolean {
  const p = resolveProduct(ref);
  if (!p) return false;
  return db().prepare("DELETE FROM products WHERE id = ?").run(p.id).changes > 0;
}

/* -------------------------------------------------------------------------- */
/* Repos                                                                      */
/* -------------------------------------------------------------------------- */

export function productWorkspaces(productId: string): ProductRepo[] {
  tables();
  return db()
    .prepare("SELECT r.product_id, r.workspace_id, r.role, w.path, w.name FROM product_repos r JOIN workspaces w ON w.id = r.workspace_id WHERE r.product_id = ? ORDER BY w.name, w.path")
    .all(productId) as ProductRepo[];
}

/** The product's repos, each with whether its folder is still on disk (a missing repo cannot be opened). */
export function productRepoStates(productId: string): Array<ProductRepo & { exists: boolean }> {
  return productWorkspaces(productId).map((r) => ({ ...r, exists: fs.existsSync(r.path) }));
}

/** The product a workspace belongs to. With several, the oldest. */
export function productForWorkspace(workspaceId: string): Product | null {
  tables();
  return (
    (db()
      .prepare("SELECT p.* FROM products p JOIN product_repos r ON r.product_id = p.id WHERE r.workspace_id = ? ORDER BY p.created_at, p.rowid LIMIT 1")
      .get(workspaceId) as Product | undefined) ?? null
  );
}

/** Attach a workspace to a product, or change its role if it is already attached. */
export function attachWorkspace(ref: string, workspaceId: string, role: unknown = "other"): ProductRepo {
  tables();
  const p = mustProduct(ref);
  const w: Workspace | null = Workspaces.get(workspaceId);
  if (!w) throw new UserError(`No workspace "${workspaceId}".`);
  db().prepare("INSERT INTO product_repos (product_id, workspace_id, role) VALUES (?, ?, ?) ON CONFLICT(product_id, workspace_id) DO UPDATE SET role = excluded.role").run(p.id, w.id, cleanRole(role));
  db().prepare("UPDATE products SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(p.id);
  return productWorkspaces(p.id).find((r) => r.workspace_id === w.id)!;
}

/** Returns false when the workspace was not attached. */
export function detachWorkspace(ref: string, workspaceId: string): boolean {
  tables();
  const p = mustProduct(ref);
  const changed = db().prepare("DELETE FROM product_repos WHERE product_id = ? AND workspace_id = ?").run(p.id, workspaceId).changes > 0;
  if (changed) db().prepare("UPDATE products SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(p.id);
  return changed;
}
