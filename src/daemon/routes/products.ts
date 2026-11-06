/**
 * The Products module over HTTP. A product is addressed by id (p_…) or slug. Its repos are workspaces (w_…).
 *
 *   GET    /api/products                              every product, with its repos and spend
 *   POST   /api/products                              { name, slug?, description?, status?, budget_usd_month? }
 *   GET    /api/products/:id                          one product with its repos and spend
 *   GET    /api/products/for-workspace/:id            the product a workspace belongs to (the oldest), with its repos and this workspace's role
 *   PATCH  /api/products/:id                          { name?, description?, status?, budget_usd_month? } ("" or null clears the budget)
 *   DELETE /api/products/:id                          removes the product; its workspaces stay
 *   POST   /api/products/:id/repos                    { workspace: w_…, role?: web|api|mobile|worker|other }
 *   DELETE /api/products/:id/repos?workspace=w_…      detach a workspace
 *   GET    /api/portfolio                             every product with roadmap progress, last verify and spend
 */
import { Workspaces } from "../../workspaces";
import { productSpend } from "../../products/cost";
import { portfolio } from "../../products/portfolio";
import { attachWorkspace, createProduct, deleteProduct, detachWorkspace, getProduct, listProducts, productForWorkspace, productRepoStates, productWorkspaces, resolveProduct, updateProduct, type Product } from "../../products/store";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A product with what the list and the detail both show: its repos and its spend. */
function view(p: Product) {
  return { ...p, repos: productRepoStates(p.id), spend: productSpend(p.id) };
}

function must(ref: string): Product {
  const p = resolveProduct(ref);
  if (!p) throw new HttpError(404, `No product "${ref}".`);
  return p;
}

export const productRoutes: RouteModule = async (c: Ctx) => {
  let m: RegExpMatchArray | null;

  if (c.path === "/api/products" && c.method === "GET") return json({ products: listProducts().map(view) });
  if (c.path === "/api/products" && c.method === "POST") {
    const b = c.body;
    return json({ product: view(createProduct({ name: str(b.name) ?? "", slug: str(b.slug), description: str(b.description), status: str(b.status), budget_usd_month: b.budget_usd_month })) }, 201);
  }
  if (c.path === "/api/portfolio" && c.method === "GET") return json({ products: portfolio() });

  if ((m = c.match(/^\/api\/products\/for-workspace\/([^/]+)$/)) && c.method === "GET") {
    const id = decodeURIComponent(m[1]!);
    if (!Workspaces.get(id)) throw new HttpError(404, `No workspace "${id}".`);
    const p = productForWorkspace(id);
    if (!p) return json({ workspace: id, product: null });
    const role = productWorkspaces(p.id).find((r) => r.workspace_id === id)?.role ?? "other";
    return json({ workspace: id, product: { ...view(p), role } });
  }

  if ((m = c.match(/^\/api\/products\/([^/]+)\/repos$/))) {
    const p = must(decodeURIComponent(m[1]!));
    if (c.method === "POST") {
      const ws = str(c.body.workspace) ?? str(c.body.workspaceId) ?? "";
      if (!Workspaces.get(ws)) throw new HttpError(404, `No workspace "${ws}".`);
      attachWorkspace(p.id, ws, c.body.role);
      return json({ product: view(getProduct(p.id)!) }, 201);
    }
    if (c.method === "DELETE") {
      const ws = c.q("workspace") ?? "";
      if (!detachWorkspace(p.id, ws)) throw new HttpError(404, `Workspace "${ws}" is not attached to ${p.name}.`);
      return json({ product: view(getProduct(p.id)!) });
    }
  }

  if ((m = c.match(/^\/api\/products\/([^/]+)$/))) {
    const ref = decodeURIComponent(m[1]!);
    if (c.method === "GET") return json({ product: view(must(ref)) });
    if (c.method === "PATCH") {
      const b = c.body;
      const patch: Record<string, unknown> = {};
      for (const k of ["name", "description", "status", "budget_usd_month"] as const) if (k in b) patch[k] = b[k];
      must(ref);
      return json({ product: view(updateProduct(ref, patch)) });
    }
    if (c.method === "DELETE") {
      must(ref);
      return json({ removed: deleteProduct(ref) });
    }
  }

  return null;
};
