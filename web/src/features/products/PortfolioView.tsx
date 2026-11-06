import { useContext, useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ask } from "@/components/ui/dialogs";
import { Field, Select, type Option } from "@/components/ui/form";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { switchWorkspace } from "@/features/factory/open";
import { WorkspaceContext } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { ProductDetail } from "./ProductDetail";
import { REPO_ROLES, useProductActions, usePortfolio, type PortfolioProduct, type PortfolioRepo, type ProductStatus, type RepoRole } from "./data";
import { budgetBar, isCurrentProduct, isLooseWorkspace, primaryRepo, repoSwitch, shippedPercent, sortCurrentFirst, spendLine, type BudgetTone } from "./logic";

const STATUS_TONE: Record<ProductStatus, "neutral" | "green" | "amber"> = {
  idea: "neutral",
  building: "neutral",
  staging: "amber",
  live: "green",
  paused: "neutral",
  archived: "neutral",
};

const FILL: Record<BudgetTone, string> = {
  none: "bg-accent",
  ok: "bg-accent",
  near: "bg-[var(--color-warning)]",
  over: "bg-[var(--color-danger)]",
};

const ROLE_OPTIONS: Option[] = REPO_ROLES.map((r) => ({ value: r, label: r }));

const SMALL = "text-[length:var(--text-sm)]";
const LABEL = "text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted";

/** The portfolio: every product as a card. Selecting one opens its editor in the same view. */
export function PortfolioView() {
  const q = usePortfolio();
  const { create } = useProductActions();
  const [selected, setSelected] = useState<string | null>(null);
  // Only mounted inside the shell, so there is always a workspace context; the portfolio itself does not need one.
  const ws = useContext(WorkspaceContext);
  const current = ws?.root ?? null;

  if (selected) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setSelected(null)}>
          <ArrowLeft />
          Portfolio
        </Button>
        <ProductDetail productId={selected} onDeleted={() => setSelected(null)} />
      </div>
    );
  }

  const newProduct = async () => {
    const name = await ask({ title: "New product", label: "Name", placeholder: "e.g. Acme Pay", confirmLabel: "Create", validate: (v) => (v.trim() ? null : "Give it a name.") });
    if (!name?.trim()) return;
    create.mutate({ name: name.trim() }, { onSuccess: (p) => setSelected(p.id) });
  };

  const products = sortCurrentFirst(q.data ?? [], current);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-[length:var(--text-2xl)] font-semibold leading-[var(--leading-tight)] text-fg">Portfolio</h1>
          <p className={cn(SMALL, "text-fg-muted")}>Every product, its repos, their roadmaps and what the agents have cost.</p>
        </div>
        <Button variant="primary" size="sm" onClick={newProduct} disabled={create.isPending}>
          <Plus />
          New product
        </Button>
      </div>

      {isLooseWorkspace(current, q.data) && ws && <LooseWorkspace workspaceId={ws.root} name={ws.workspace.name} products={q.data ?? []} />}

      {q.isLoading && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      )}

      {q.isError && <p className={cn(SMALL, "text-[var(--color-danger)]")}>{q.error instanceof Error ? q.error.message : "The portfolio did not load."}</p>}

      {q.isSuccess && products.length === 0 && (
        <Empty title="No products yet" hint="A product is what you ship. Attach the repos that make it up and the portfolio shows their progress and cost." action={<Button variant="subtle" size="sm" onClick={newProduct}>New product</Button>} />
      )}

      {products.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} current={current} onOpen={() => setSelected(p.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The open workspace is in no product: attach it to one, or make a product from it. */
function LooseWorkspace({ workspaceId, name, products }: { workspaceId: string; name: string; products: PortfolioProduct[] }) {
  const { create, attach } = useProductActions();
  const [adding, setAdding] = useState(false);
  const [product, setProduct] = useState("");
  const [role, setRole] = useState<RepoRole>("other");

  const newFromHere = async () => {
    const title = await ask({ title: "New product", label: "Name", initial: name, confirmLabel: "Create", validate: (v) => (v.trim() ? null : "Give it a name.") });
    if (!title?.trim()) return;
    create.mutate({ name: title.trim() }, { onSuccess: (p) => attach.mutate({ ref: p.id, workspace: workspaceId, role: "other" }) });
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-raised px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cn(SMALL, "text-fg")}>
          This workspace isn&apos;t in a product <span className="font-mono text-fg-muted">· {name}</span>
        </span>
        <span className="flex items-center gap-2">
          <Button variant="subtle" size="sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            Add to product…
          </Button>
          <Button variant="subtle" size="sm" onClick={newFromHere} disabled={create.isPending}>
            New product from this workspace
          </Button>
        </span>
      </div>
      {adding && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-[200px] flex-1 flex-col gap-1">
            <Field label="Product">
              <Select value={product} onChange={setProduct} placeholder={products.length ? "Choose a product" : "No products yet"} options={products.map((p) => ({ value: p.id, label: p.name }))} disabled={!products.length} aria-label="Product to add to" />
            </Field>
          </div>
          <div className="w-[120px]">
            <Field label="Role">
              <Select size="sm" value={role} onChange={(v) => setRole(v as RepoRole)} options={ROLE_OPTIONS} aria-label="Role in the product" />
            </Field>
          </div>
          <Button variant="primary" size="sm" disabled={!product || attach.isPending} onClick={() => attach.mutate({ ref: product, workspace: workspaceId, role }, { onSuccess: () => setAdding(false) })}>
            Attach
          </Button>
        </div>
      )}
    </div>
  );
}

function ProductCard({ product: p, current, onOpen }: { product: PortfolioProduct; current: string | null; onOpen: () => void }) {
  const bar = budgetBar(p.spend);
  const pct = shippedPercent(p.progress);
  const holds = isCurrentProduct(p, current);
  // Open goes to the product's primary repo, unless that is the open workspace or its folder is gone.
  const primary = primaryRepo(p.repos);
  const openTarget = primary ? repoSwitch(primary, current) : null;
  return (
    <article className={cn("flex flex-col gap-3 rounded-lg border bg-raised p-3", holds ? "border-line-strong" : "border-line")}>
      <button type="button" onClick={onOpen} className="flex flex-col gap-1 rounded-md text-left transition-colors duration-[var(--duration-fast)] hover:bg-hover focus-visible:outline-none">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[length:var(--text-lg)] font-semibold text-fg">{p.name}</span>
            {holds && <Badge tone="accent">Current</Badge>}
          </span>
          <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
        </div>
        <span className={cn(SMALL, "font-mono text-fg-muted")}>{p.slug}</span>
        {p.description && <span className={cn(SMALL, "line-clamp-2 text-fg-muted")}>{p.description}</span>}
      </button>

      <div className="flex flex-col gap-1">
        <span className={LABEL}>Roadmap</span>
        <span className={cn(SMALL, "font-mono text-fg")}>{pct === null ? "No roadmap items yet" : `${p.progress.shipped} of ${p.progress.items} shipped (${pct}%)`}</span>
      </div>

      <div className="flex flex-col gap-1">
        <span className={LABEL}>Repos</span>
        {p.repos.length === 0 && <span className={cn(SMALL, "text-fg-muted")}>No repos attached.</span>}
        {p.repos.map((r) => (
          <RepoRow key={r.workspace_id} repo={r} current={current} />
        ))}
      </div>

      {primary && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="subtle" size="sm" disabled={!openTarget?.canSwitch} title={openTarget?.missing ? "Its folder is missing" : openTarget?.open ? "Already open" : `Open ${primary.name}`} onClick={() => switchWorkspace(primary.workspace_id, "portfolio")}>
            Open
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={LABEL}>Spend</span>
          <span className={cn(SMALL, "font-mono", bar.tone === "over" ? "text-[var(--color-danger)]" : bar.tone === "near" ? "text-[var(--color-warning)]" : "text-fg-muted")}>
            {bar.tone === "over" ? "Over budget" : bar.tone === "near" ? "Near budget" : bar.tone === "none" ? "No budget" : ""}
          </span>
        </div>
        {bar.tone !== "none" && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-active" role="meter" aria-label="Spend against budget" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar.width)}>
            <div className={cn("h-full rounded-full transition-[width] duration-[var(--duration-base)] ease-[var(--ease-out)]", FILL[bar.tone])} style={{ width: `${bar.width}%` }} />
          </div>
        )}
        <span className={cn(SMALL, "font-mono text-fg")}>{spendLine(p.spend)}</span>
      </div>
    </article>
  );
}

/** One repo in a card: its role and name, whether it is the open workspace or missing, and Switch. */
function RepoRow({ repo: r, current }: { repo: PortfolioRepo; current: string | null }) {
  const s = repoSwitch(r, current);
  return (
    <div className={cn(SMALL, "flex items-center justify-between gap-2")}>
      <span className="flex min-w-0 items-center gap-2">
        <Badge tone="neutral">{r.role}</Badge>
        <span className="truncate text-fg">{r.name}</span>
        {s.open && (
          <span className="flex shrink-0 items-center gap-1 text-accent">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            open
          </span>
        )}
        {s.missing && <Badge tone="red">missing</Badge>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="font-mono text-fg-muted">
          {r.progress ? `${r.progress.shipped}/${r.progress.items}` : "no roadmap"}
          {" · "}
          {!r.verify ? "no verify" : r.verify.state === "passed" ? <span className="text-[var(--color-success)]">verify passed</span> : <span className="text-[var(--color-danger)]">verify failed</span>}
        </span>
        {s.canSwitch && (
          <Button variant="ghost" size="xs" onClick={() => switchWorkspace(r.workspace_id, "portfolio")} aria-label={`Switch to ${r.name}`}>
            Switch
          </Button>
        )}
      </span>
    </div>
  );
}
