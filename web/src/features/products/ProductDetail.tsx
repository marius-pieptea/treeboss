import { useContext, useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Field, Input, Select, Textarea, type Option } from "@/components/ui/form";
import { Badge, Skeleton } from "@/components/ui/misc";
import { switchWorkspace } from "@/features/factory/open";
import { useWorkspaces } from "@/lib/queries";
import { WorkspaceContext } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { REPO_ROLES, useProduct, useProductActions, PRODUCT_STATUSES, type ProductInput, type ProductStatus, type ProductView, type RepoRole } from "./data";
import { budgetBar, money, repoSwitch, spendLine } from "./logic";

const SMALL = "text-[length:var(--text-sm)]";

interface Draft {
  name: string;
  description: string;
  status: ProductStatus;
  budget: string;
}

const draftOf = (p: ProductView): Draft => ({ name: p.name, description: p.description, status: p.status, budget: p.budget_usd_month === null ? "" : String(p.budget_usd_month) });

const STATUS_OPTIONS: Option[] = PRODUCT_STATUSES.map((s) => ({ value: s, label: s }));
const ROLE_OPTIONS: Option[] = REPO_ROLES.map((r) => ({ value: r, label: r }));

/** The editor for one product: its fields, its repos, and what it has cost. Edits are saved together. */
export function ProductDetail({ productId, onDeleted }: { productId: string; onDeleted?: () => void }) {
  const q = useProduct(productId);
  const ws = useWorkspaces();
  const { update, attach, detach, remove } = useProductActions();
  const current = useContext(WorkspaceContext)?.root ?? null;
  const p = q.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newWorkspace, setNewWorkspace] = useState("");
  const [newRole, setNewRole] = useState<RepoRole>("other");

  // A fresh copy from the server (after a save, or another tab) replaces the draft.
  useEffect(() => {
    if (p) setDraft(draftOf(p));
  }, [p?.id, p?.updated_at]);

  if (q.isLoading || !p || !draft) return q.isError ? <p className={cn(SMALL, "text-[var(--color-danger)]")}>{q.error instanceof Error ? q.error.message : "The product did not load."}</p> : <Skeleton className="h-64 rounded-lg" />;

  const dirty = draft.name !== p.name || draft.description !== p.description || draft.status !== p.status || draft.budget !== (p.budget_usd_month === null ? "" : String(p.budget_usd_month));

  const save = () => {
    const input: ProductInput = {};
    if (draft.name.trim() !== p.name) input.name = draft.name.trim();
    if (draft.description !== p.description) input.description = draft.description;
    if (draft.status !== p.status) input.status = draft.status;
    if (draft.budget !== (p.budget_usd_month === null ? "" : String(p.budget_usd_month))) {
      const n = draft.budget.trim() === "" ? null : Number(draft.budget);
      if (n !== null && (!Number.isFinite(n) || n < 0)) return toast.error("The budget is a number of dollars a month, zero or more.");
      input.budget_usd_month = n;
    }
    if (!Object.keys(input).length) return;
    update.mutate({ ref: p.id, input });
  };

  const attached = new Set(p.repos.map((r) => r.workspace_id));
  const free = (ws.data ?? []).filter((w) => !attached.has(w.id));
  const bar = budgetBar(p.spend);
  const s = p.spend;

  const onDelete = async () => {
    const ok = await confirm({ title: `Delete ${p.name}?`, description: "The product and its repo links go. The workspaces and their sessions stay.", confirmLabel: "Delete", danger: true });
    if (ok) remove.mutate(p.id, { onSuccess: () => onDeleted?.() });
  };

  return (
    <div className="flex max-w-[820px] flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[length:var(--text-lg)] font-semibold text-fg">{p.name}</h2>
          <span className="flex items-center gap-2">
            <Badge tone="neutral">{p.slug}</Badge>
            <IconButton label="Delete product" variant="dangerGhost" onClick={onDelete} disabled={remove.isPending}>
              <Trash2 />
            </IconButton>
          </span>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} />
          </Field>
          <Field label="Status">
            <Select value={draft.status} onChange={(v) => setDraft({ ...draft, status: v as ProductStatus })} options={STATUS_OPTIONS} aria-label="Status" />
          </Field>
          <Field label="Budget, USD a month" hint="Empty for no budget. Spend above it is flagged on the portfolio.">
            <Input type="number" min={0} step="0.01" inputMode="decimal" value={draft.budget} onChange={(e) => setDraft({ ...draft, budget: e.target.value })} placeholder="No budget" />
          </Field>
          <Field label="About" className="md:col-span-2">
            <Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={3} maxLength={2000} />
          </Field>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="subtle" size="sm" onClick={() => setDraft(draftOf(p))} disabled={!dirty || update.isPending}>
            Reset
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!dirty || update.isPending}>
            Save
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Repos</h3>
        {p.repos.length === 0 && <p className={cn(SMALL, "text-fg-muted")}>No repos yet. A product is the repos that make it up: web, api, mobile, worker.</p>}
        {p.repos.map((r) => {
          const s = repoSwitch(r, current);
          return (
            <div key={r.workspace_id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-raised p-3">
              <div className="flex min-w-0 flex-col">
                <span className={cn(SMALL, "flex min-w-0 items-center gap-2 text-fg")}>
                  <span className="truncate">{r.name}</span>
                  {s.open && (
                    <span className="flex shrink-0 items-center gap-1 text-accent">
                      <span className="size-1.5 rounded-full bg-accent" aria-hidden />
                      open
                    </span>
                  )}
                  {s.missing && <Badge tone="red">missing</Badge>}
                </span>
                <span className={cn("truncate font-mono text-[length:var(--text-xs)] text-fg-muted")}>{r.path}</span>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                {s.canSwitch && (
                  <Button variant="ghost" size="xs" onClick={() => switchWorkspace(r.workspace_id, "portfolio")} aria-label={`Switch to ${r.name}`}>
                    Switch
                  </Button>
                )}
                <span className="w-[120px]">
                  <Select size="sm" value={r.role} onChange={(role) => attach.mutate({ ref: p.id, workspace: r.workspace_id, role: role as RepoRole })} options={ROLE_OPTIONS} aria-label={`Role of ${r.name}`} />
                </span>
                <IconButton label={`Detach ${r.name}`} variant="ghost" size="icon-sm" onClick={() => detach.mutate({ ref: p.id, workspace: r.workspace_id })} disabled={detach.isPending}>
                  <X />
                </IconButton>
              </span>
            </div>
          );
        })}

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-[200px] flex-1 flex-col gap-1">
            <Field label="Add a workspace">
              <Select value={newWorkspace} onChange={setNewWorkspace} placeholder={free.length ? "Choose a workspace" : "Every workspace is attached"} options={free.map((w) => ({ value: w.id, label: `${w.name}`, hint: w.path }))} disabled={!free.length} aria-label="Workspace to add" />
            </Field>
          </div>
          <div className="w-[120px]">
            <Field label="Role">
              <Select size="sm" value={newRole} onChange={(v) => setNewRole(v as RepoRole)} options={ROLE_OPTIONS} aria-label="Role of the new repo" />
            </Field>
          </div>
          <Button variant="subtle" size="sm" disabled={!newWorkspace || attach.isPending} onClick={() => attach.mutate({ ref: p.id, workspace: newWorkspace, role: newRole }, { onSuccess: () => setNewWorkspace("") })}>
            Attach
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3">
        <h3 className="text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Spend</h3>
        {s ? (
          <>
            {s.budgetUsdMonth !== null && (
              <div className="h-1 w-full overflow-hidden rounded-full bg-active" role="meter" aria-label="Spend against budget" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bar.width)}>
                <div className={cn("h-full rounded-full transition-[width] duration-[var(--duration-base)] ease-[var(--ease-out)]", bar.tone === "over" ? "bg-[var(--color-danger)]" : bar.tone === "near" ? "bg-[var(--color-warning)]" : "bg-accent")} style={{ width: `${bar.width}%` }} />
              </div>
            )}
            <p className={cn(SMALL, "font-mono", s.overBudget ? "text-[var(--color-danger)]" : "text-fg")}>{spendLine(s)}{s.overBudget ? " · over budget" : ""}</p>
            <dl className="grid grid-cols-3 gap-2">
              <Stat label="Last 7 days" value={money(s.last7Days)} />
              <Stat label="This month" value={money(s.thisMonth)} />
              <Stat label="All time" value={money(s.allTime)} />
            </dl>
          </>
        ) : (
          <p className={cn(SMALL, "text-fg-muted")}>No spend yet.</p>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-raised px-2 py-1">
      <dt className="text-[length:var(--text-xs)] text-fg-muted">{label}</dt>
      <dd className="font-mono text-[length:var(--text-base)] text-fg">{value}</dd>
    </div>
  );
}
