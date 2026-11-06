import { Layers, ChevronsUpDown } from "lucide-react";
import { Badge, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/overlay";
import { useWorkspaceProduct } from "@/features/products/data";
import { repoSwitch } from "@/features/products/logic";
import { cn } from "@/lib/utils";
import type { FactoryPage } from "@/lib/store";
import { switchWorkspace } from "./open";

/**
 * The factory's context: the product the open workspace belongs to, the workspace and its role, and a menu to
 * switch to a sibling repo of the same product (keeping the factory page) or to all products. Sits above every page.
 */
export function ContextStrip({ workspaceId, workspaceName, page, onAllProducts }: { workspaceId: string; workspaceName: string; page: FactoryPage; onAllProducts: () => void }) {
  const q = useWorkspaceProduct(workspaceId);
  const product = q.data ?? null;

  if (q.isLoading) return <Skeleton className="mx-3 my-1.5 h-6 w-64 rounded-md" />;

  const siblings = product ? product.repos.filter((r) => r.workspace_id !== workspaceId) : [];
  const repo = product?.repos.find((r) => r.workspace_id === workspaceId);

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-[length:var(--text-sm)]">
      {product && repo ? (
        <DropdownMenu
          entries={siblings.map((r) => {
            const s = repoSwitch(r, workspaceId);
            return {
              label: r.name,
              badge: !r.exists ? <Badge tone="red">missing</Badge> : <Badge tone="neutral">{r.role}</Badge>,
              disabled: !s.canSwitch,
              onSelect: () => switchWorkspace(r.workspace_id, page),
            };
          })}
          footer={[{ label: "All products…", icon: <Layers />, onSelect: onAllProducts }]}
          trigger={
            <Button variant="ghost" size="sm" className="min-w-0 gap-1.5 px-2" aria-label="Switch repo of this product">
              <Layers className="text-accent" />
              <span className="truncate font-medium text-fg">{product.name}</span>
              <span className="text-fg-faint">/</span>
              <span className={cn("truncate font-mono text-fg-muted")}>{repo.name}</span>
              <Badge tone="neutral">{repo.role}</Badge>
              <ChevronsUpDown className="size-3 shrink-0 text-fg-faint" />
            </Button>
          }
        />
      ) : (
        <>
          <span className="truncate font-mono text-fg-muted">{workspaceName}</span>
          <span className="text-fg-faint">·</span>
          <span className="truncate text-fg-muted">Not in a product</span>
          <Button variant="ghost" size="sm" className="px-2" onClick={onAllProducts}>
            All products…
          </Button>
        </>
      )}
    </div>
  );
}
