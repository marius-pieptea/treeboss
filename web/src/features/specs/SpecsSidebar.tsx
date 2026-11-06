import { useEffect, useState } from "react";
import { bus } from "@/lib/bus";
import { BookMarked, Compass, FilePlus2, FileText, FolderPlus, Gauge, Play, RefreshCw, ScrollText } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace";
import { useUi, useWs } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { Button, IconButton } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/overlay";
import { specKey, useSpecActions, useSpecs } from "./data";
import { ago, CONSTITUTION_PATH, nextNumber, percent, statusLabel, statusTone, type FeatureInfo, type SpecsOverview } from "./logic";
import { NewFeatureDialog } from "./NewFeatureDialog";
import { useRunner } from "./useRunner";

function Progress({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = percent(done, total);
  return (
    <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className={cn("h-[3px] overflow-hidden rounded-full bg-active", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-200 ease-out", pct === 100 ? "bg-green" : "bg-accent")} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ConstitutionRow({ o, onCreate, creating }: { o: SpecsOverview; onCreate: () => void; creating: boolean }) {
  const { root } = useWorkspace();
  const openTab = useUi((s) => s.openTab);
  const c = o.constitution;
  const open = () => c.exists && openTab({ kind: "file", root, path: CONSTITUTION_PATH, title: "constitution.md" });
  return (
    <div className="mx-2 mb-1 flex items-center gap-2 rounded-lg border border-line bg-raised px-2 py-1.5">
      <BookMarked className={cn("size-3.5 shrink-0", c.exists ? "text-accent" : "text-fg-faint")} />
      <button onClick={open} disabled={!c.exists} className="min-w-0 flex-1 text-left text-[12.5px] outline-none enabled:hover:text-accent disabled:cursor-default">
        <div className="font-medium">Constitution</div>
        <div className="truncate text-[11px] text-fg-muted">{!c.exists ? "The principles every feature follows" : c.placeholders ? "Template: still has placeholders" : `${Math.max(1, Math.round(c.bytes / 100) / 10)} KB`}</div>
      </button>
      {!c.exists ? (
        <Button size="xs" variant="outline" data-create-constitution onClick={onCreate} disabled={creating}>
          <FilePlus2 /> Create
        </Button>
      ) : c.placeholders ? (
        <Badge tone="amber">draft</Badge>
      ) : (
        <Badge tone="green">ready</Badge>
      )}
    </div>
  );
}

function FeatureRow({ f, active, onOpen, onStep, onImplement, onArchitecture }: { f: FeatureInfo; active: boolean; onOpen: () => void; onStep: () => void; onImplement: (parallel?: boolean) => void; onArchitecture: () => void }) {
  return (
    <ContextMenu
      entries={[
        { label: "Open", onSelect: onOpen },
        { separator: true },
        { label: "Open the workflow", icon: <Play />, onSelect: onStep },
        { label: "Implement…", icon: <Gauge />, disabled: !f.files.tasks || f.tasks.total === 0, onSelect: () => onImplement(false) },
        { label: "Implement in parallel…", disabled: !f.files.tasks || f.tasks.total === 0, onSelect: () => onImplement(true) },
        { label: "Discuss architecture…", icon: <Compass />, onSelect: onArchitecture },
      ]}
    >
      <button data-feature={f.id} onClick={onOpen} className={cn("group relative mx-1 flex w-[calc(100%-0.5rem)] flex-col gap-1 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover", active && "bg-active")}>
        {active && <span className="absolute left-0 top-2 h-[calc(100%-1rem)] w-[2px] rounded-r bg-accent" />}
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 rounded bg-raised px-1 font-mono text-[10px] text-fg-faint">{f.number.length > 3 ? f.number.slice(2, 8) : f.number}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{f.title}</span>
          <Badge tone={statusTone(f.status)}>{statusLabel(f.status)}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Progress done={f.tasks.done} total={f.tasks.total} className="flex-1" />
          <span className="font-mono text-[10.5px] text-fg-faint">{f.tasks.total ? `${f.tasks.done}/${f.tasks.total}` : ago(f.updatedAt)}</span>
        </div>
      </button>
    </ContextMenu>
  );
}

/** The Specs view: the constitution, the features and where each stands. */
export function SpecsSidebar() {
  const { root } = useWorkspace();
  const ws = useWs();
  const openTab = useUi((s) => s.openTab);
  const qc = useQueryClient();
  const specs = useSpecs(root);
  const actions = useSpecActions(root);
  const run = useRunner(root);
  const [newOpen, setNewOpen] = useState(false);
  const o = specs.data;
  // The command palette opens these.
  useEffect(() => bus.on("specs-new-feature", () => setNewOpen(true)), []);
  useEffect(() => bus.on("specs-architecture", () => run.architecture(null)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const openFeature = (f: FeatureInfo) => openTab({ kind: "spec", root, feature: f.id, title: f.title });
  const empty = !!o && !o.constitution.exists && o.features.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-specs-sidebar>
      <div className="flex h-9 shrink-0 items-center gap-0.5 px-2">
        <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Specs</span>
        <IconButton label="New feature" size="icon-sm" data-new-feature onClick={() => setNewOpen(true)}>
          <FolderPlus />
        </IconButton>
        <IconButton label="Discuss architecture" size="icon-sm" data-architecture onClick={() => run.architecture(null)}>
          <Compass />
        </IconButton>
        <IconButton label="Refresh" size="icon-sm" onClick={() => void qc.invalidateQueries({ queryKey: specKey.root(root) })}>
          <RefreshCw className={cn(specs.isFetching && "animate-spin-fast")} />
        </IconButton>
      </div>

      {specs.isPending ? (
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : specs.error ? (
        <Empty icon={<ScrollText />} title="Could not read the specs" hint={(specs.error as Error).message} action={<Button size="sm" variant="outline" onClick={() => void specs.refetch()}>Try again</Button>} />
      ) : empty ? (
        <Empty
          icon={<ScrollText />}
          title="No specs yet"
          hint="Write down what the project stands for, then what each feature should do, before the agents build it."
          action={
            <div className="mt-1 flex flex-col gap-1.5">
              <Button size="sm" variant="primary" data-create-constitution onClick={() => actions.initConstitution.mutate(undefined)} disabled={actions.initConstitution.isPending}>
                <BookMarked /> Create constitution
              </Button>
              <Button size="sm" variant="outline" onClick={() => setNewOpen(true)}>
                <FolderPlus /> New feature
              </Button>
            </div>
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          {o && <ConstitutionRow o={o} onCreate={() => actions.initConstitution.mutate(undefined)} creating={actions.initConstitution.isPending} />}
          {o && o.features.length === 0 ? (
            <Empty icon={<FileText />} title="No features yet" hint="A feature is a folder with a spec, a plan and tasks." action={<Button size="sm" variant="outline" onClick={() => setNewOpen(true)}><FolderPlus /> New feature</Button>} className="py-6" />
          ) : (
            <>
              <div className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">Features · {o?.features.length}</div>
              {[...(o?.features ?? [])].reverse().map((f) => (
                <FeatureRow
                  key={f.id}
                  f={f}
                  active={ws.activeTab === `spec:${root}:${f.id}`}
                  onOpen={() => openFeature(f)}
                  onStep={() => openFeature(f)}
                  onImplement={(p) => run.implement(f, p)}
                  onArchitecture={() => run.architecture(f)}
                />
              ))}
            </>
          )}
          {o?.specify.path && <div className="mt-3 px-3 text-[10.5px] leading-snug text-fg-faint">The same folders work with the <span className="font-mono">specify</span> tool on this machine.</div>}
        </div>
      )}

      <NewFeatureDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        busy={actions.createFeature.isPending}
        nextNumber={nextNumber(o)}
        onCreate={(name, description) =>
          actions.createFeature.mutate(
            { name, description: description || undefined },
            {
              onSuccess: (r) => {
                setNewOpen(false);
                openFeature(r.feature);
              },
            },
          )
        }
      />
      {run.dialog}
    </div>
  );
}
