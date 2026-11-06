/**
 * A plan, opened as a tab: the markdown file the daemon wrote when the agent called `plan_submit`, rendered,
 * under a sticky bar with the decision (Approve and build, Skip plan, Ask for changes), an Edit toggle that swaps
 * in the real editor on the same file, and Promote to spec. The file is the plan: edit it and what you approve
 * is what you edited. The bar goes away once the plan is decided and leaves a status chip behind.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ClipboardList, Eye, FileText, FileX, Hammer, ListChecks, MessageSquarePlus, Pencil, Play, ScrollText, SkipForward } from "lucide-react";
import { useSession } from "@/lib/queries";
import { useUi, type Tab } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";
import { Empty, Skeleton } from "@/components/ui/misc";
import { FileTab } from "@/features/editor/FileTab";
import { MarkdownPreview } from "@/features/editor/MarkdownPreview";
import { useSpecs } from "@/features/specs/data";
import { useRunner } from "@/features/specs/useRunner";
import { usePlanApprove, usePlanDecisions, usePlanFile, usePlanState } from "./plan-data";
import { approveLabel, planBar, planBody, planForTab, statusLabel } from "./plan-logic";

type PlanTabT = Extract<Tab, { kind: "plan" }>;

const tone = {
  decide: "border-violet/40 bg-violet/10 text-violet",
  approved: "border-green/40 bg-green/10 text-green",
  superseded: "border-line bg-raised text-fg-muted",
  gone: "border-line bg-raised text-fg-muted",
} as const;

export function PlanViewer({ tab }: { tab: PlanTabT }) {
  const qc = useQueryClient();
  const openTab = useUi((s) => s.openTab);
  const session = useSession(tab.sessionId).data?.session;
  const state = usePlanState(tab.sessionId, true);
  const plan = planForTab(state.data, tab);
  const bar = planBar(plan, state.data, session?.status ?? "idle");
  const file = usePlanFile(tab.sessionId, plan?.id ?? tab.planId);
  const approver = usePlanApprove(tab.sessionId, tab.root);
  const actions = approver.actions;
  const dec = usePlanDecisions(tab.sessionId, tab.root);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // An approved spec-depth plan continues in the specs workflow: tasks first, then Implement.
  const runner = useRunner(tab.root);
  const specs = useSpecs(tab.root);
  const feature = plan?.depth === "spec" && plan.feature ? (specs.data?.features.find((f) => f.id === plan.feature) ?? null) : null;

  // The daemon says when the plan or its file changed (a revision landed, a decision was made).
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent).detail === tab.sessionId) void qc.invalidateQueries({ queryKey: ["plan-file", tab.sessionId] });
    };
    window.addEventListener("trb:plan", on);
    return () => window.removeEventListener("trb:plan", on);
  }, [tab.sessionId, qc]);

  // Back from the editor, show what was saved.
  useEffect(() => {
    if (!editing) void qc.invalidateQueries({ queryKey: ["plan-file", tab.sessionId] });
    void qc.invalidateQueries({ queryKey: ["plan-state", tab.sessionId] });
  }, [editing]);

  const path = plan?.path ?? file.data?.path ?? tab.path;
  const busy = actions.approve.isPending || actions.changes.isPending || dec.skip.isPending || dec.promote.isPending;
  const decide = bar.kind === "decide";
  const canDecide = bar.kind === "decide" && bar.canDecide && !busy && !editing;
  const openSpec = (feature: string) => openTab({ kind: "spec", root: tab.root, feature, title: feature });

  const approve = () => {
    if (plan) approver.approve(plan);
  };
  const promote = () => {
    if (!plan) return;
    dec.promote.mutate(plan.id, {
      onSuccess: (r) => {
        openSpec(r.feature);
        toast.success("Promoted to a spec", { description: `${r.dir}: spec.md and plan.md are written. The Specify and Clarify steps are still open.` });
      },
    });
  };

  const fileTab = { id: tab.id, kind: "file" as const, root: tab.root, path: path ?? "", title: tab.title };
  const head = plan ? chip(plan.status === "draft" && plan.edited ? "edited" : null) : null;

  const btn = "data-[busy=true]:opacity-60";
  return (
    <div className="flex h-full min-h-0 flex-col" data-plan-viewer={plan?.id ?? tab.planId} data-plan-status={plan?.status ?? "gone"}>
      <div className="sticky top-0 z-10 shrink-0 border-b border-line bg-panel">
        <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-1.5">
          <ClipboardList className="size-4 shrink-0 text-violet" />
          <span className="min-w-0 max-w-[40ch] truncate text-[13px] font-semibold" title={plan?.title}>
            {plan?.title ?? tab.title}
          </span>
          {plan && (
            <span data-plan-status-chip className={cn("flex h-5 items-center gap-1 rounded-full border px-2 text-[11px]", tone[bar.kind])}>
              {bar.kind === "approved" && <Check className="size-3" strokeWidth={2.6} />}
              {statusLabel(plan, bar)}
            </span>
          )}
          {head}
          {path && (
            <button type="button" onClick={() => void navigator.clipboard?.writeText(path)} title="Copy the path" className="hidden max-w-[34ch] truncate rounded px-1 font-mono text-[11px] text-fg-faint outline-none hover:text-fg focus-visible:text-fg sm:block">
              {path}
            </button>
          )}
          {plan?.promoted && (
            <button type="button" data-plan-open-spec onClick={() => openSpec(plan.feature ?? plan.promoted!.replace(/^specs\//, ""))} className="flex h-5 items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-2 text-[11px] text-accent outline-none hover:bg-accent/15">
              <ScrollText className="size-3" /> {plan.promoted}
            </button>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {path && bar.kind !== "gone" && (
              <Button size="xs" variant={editing ? "subtle" : "ghost"} data-plan-edit aria-pressed={editing} onClick={() => setEditing((v) => !v)} title={editing ? "Back to the rendered plan" : "Edit the plan file"}>
                {editing ? <Eye /> : <Pencil />} {editing ? "Preview" : "Edit"}
              </Button>
            )}
            {plan && plan.depth === "quick" && !plan.promoted && path && bar.kind !== "gone" && (
              <Button size="xs" variant="ghost" data-plan-promote disabled={busy || editing} onClick={promote} title="Turn this plan into a spec feature (spec.md and plan.md in specs/)">
                <ScrollText /> Promote to spec
              </Button>
            )}
            {plan && plan.depth === "spec" && plan.feature && (
              <Button size="xs" variant="ghost" data-plan-open-spec onClick={() => openSpec(plan.feature!)}>
                <ScrollText /> Open spec
              </Button>
            )}
            {bar.kind === "approved" && feature && (
              <Button size="xs" variant="primary" data-plan-next={feature.files.tasks ? "implement" : "tasks"} onClick={() => (feature.files.tasks ? runner.implement(feature) : runner.step("tasks", feature))} title={feature.files.tasks ? "Start building the open tasks as a goal" : "Break the plan into tasks (tasks.md)"}>
                {feature.files.tasks ? <Play /> : <ListChecks />} {feature.files.tasks ? "Implement" : "Generate tasks"}
              </Button>
            )}
            {decide && plan && (
              <>
                <Button size="xs" variant="ghost" data-plan-skip disabled={!canDecide} onClick={() => dec.skip.mutate(plan.id)} title="Leave plan mode and let the agent carry on without the plan">
                  <SkipForward /> Skip plan
                </Button>
                <Button size="xs" variant="outline" data-plan-changes disabled={!canDecide} aria-pressed={note !== null} onClick={() => setNote(note === null ? "" : null)}>
                  <MessageSquarePlus /> Ask for changes
                </Button>
                <Button size="xs" variant="primary" data-plan-approve className={btn} data-busy={actions.approve.isPending} disabled={!canDecide} onClick={approve} title={plan.depth === "spec" ? "Approve the spec and plan, then continue in Specs" : "Leave plan mode and tell the agent to build this plan"}>
                  <Hammer /> {approveLabel(plan)}
                </Button>
              </>
            )}
          </div>
        </div>
        {decide && bar.kind === "decide" && !bar.canDecide && <p className="px-3 pb-1.5 text-[11.5px] text-fg-faint">{bar.reason}</p>}
        {decide && editing && <p className="px-3 pb-1.5 text-[11.5px] text-fg-faint">You are editing the plan file. Save it, then approve: what you approve is the file as it stands.</p>}
        {note !== null && plan && (
          <div className="flex items-start gap-2 border-t border-line px-3 py-2">
            <Textarea autoFocus rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change? e.g. split step 2, skip the migration…" className="min-h-0 flex-1 resize-none px-2.5 py-1.5 text-[12.5px]" data-plan-note />
            <Button
              size="sm"
              variant="primary"
              data-plan-send-changes
              disabled={!canDecide || !note.trim()}
              onClick={() =>
                actions.changes.mutate(
                  { planId: plan.id, note: note.trim() },
                  { onSuccess: () => setNote(null) },
                )
              }
            >
              <MessageSquarePlus /> Send note
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNote(null)}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {editing && path ? (
          <FileTab tab={fileTab} />
        ) : file.isPending || state.isPending ? (
          <div className="mx-auto flex max-w-[820px] flex-col gap-3 px-8 py-6">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4" />
            <Skeleton className="h-4" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : file.error ? (
          <Empty icon={<FileText />} title="Could not open this plan" hint={(file.error as Error).message} action={<Button size="sm" variant="outline" onClick={() => void file.refetch()}>Try again</Button>} />
        ) : !plan ? (
          <Empty icon={<FileX />} title="This plan is gone" hint="The session no longer has it." />
        ) : (
          <>
            {plan.file_missing && (
              <div className="m-3 flex items-center gap-2 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-[12px] text-fg-muted" data-plan-file-missing>
                <FileX className="size-3.5 shrink-0 text-amber" />
                <span className="flex-1">The plan file {path ? <span className="font-mono">{path}</span> : ""} is gone. This is the text the daemon kept.</span>
                <Button size="xs" variant="outline" disabled={dec.materialize.isPending} onClick={() => dec.materialize.mutate(plan.id)}>
                  Write it back
                </Button>
              </div>
            )}
            {!plan.path && (
              <div className="m-3 flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-[12px] text-fg-muted">
                <FileText className="size-3.5 shrink-0" />
                <span className="flex-1">This plan was saved before plans were files.</span>
                <Button size="xs" variant="outline" disabled={dec.materialize.isPending} onClick={() => dec.materialize.mutate(plan.id)}>
                  Write it to a file
                </Button>
              </div>
            )}
            <MarkdownPreview text={planBody(file.data?.text ?? "")} root={tab.root} path={path ?? ""} />
          </>
        )}
      </div>
      {runner.dialog}
    </div>
  );
}

/** A small tag next to the status, for "edited" (the file differs from what the agent wrote). */
function chip(label: string | null) {
  return label ? (
    <span data-plan-edited className="flex h-5 items-center rounded-full border border-amber/40 bg-amber/10 px-2 text-[11px] text-amber">
      {label}
    </span>
  ) : null;
}
