/**
 * The treeboss control in the composer's footer, beside the Build | Plan | Ask control. It is the same icon button as the other
 * composer popovers: the icon is violet while the mode is on, and a dot shows the last turn's gate outcome. Clicking it opens
 * the card: the status (read only), the mode switch and the tier override.
 */
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Dot, Minus, TreePine, X } from "lucide-react";
import { toast } from "sonner";
import { post, url } from "@/lib/api";
import { queryClient, qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Popover } from "@/components/ui/overlay";
import { Switch } from "@/components/ui/form";
import { SegTabs } from "@/components/ui/misc";
import type { Tier, TreebossViewState } from "@/lib/types";
import { TREEBOSS_TIP, gateFooter, gateProgress, gateRows, tierLabel, type GateRow } from "./treeboss-logic";

/** Turns treeboss mode on or off for a session that exists. It applies from the next turn; the session is refetched. */
export async function setSessionTreeboss(sessionId: string, enabled: boolean): Promise<boolean> {
  const r = await post<{ treeboss: boolean }>(url.session(sessionId, "treeboss"), { enabled });
  void queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
  void queryClient.invalidateQueries({ queryKey: qk.sessionsAll });
  return r.treeboss;
}

/** Sets the operator's tier for a session. null clears it, and the agent's own triage applies again. */
export async function setSessionTreebossTier(sessionId: string, tier: Tier | null): Promise<TreebossViewState | null> {
  const r = await post<{ treeboss_state: TreebossViewState | null }>(url.session(sessionId, "treeboss"), { tier });
  void queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
  void queryClient.invalidateQueries({ queryKey: qk.sessionsAll });
  return r.treeboss_state;
}

interface TreebossProps {
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
  /** The session the tier override applies to. Absent for a new session, which has no tier to set yet. */
  sessionId?: string;
  /** The session's gate state from the daemon (null while the mode is off). */
  state?: TreebossViewState | null;
}

export function TreebossToggle(props: TreebossProps) {
  const { on, disabled, state } = props;
  const progress = gateProgress(state);
  const [open, setOpen] = useState(false);
  // A dot for the last turn's gate outcome, shown only while the mode is on and a turn has been checked.
  const dot = on && progress.tone !== "idle" && (
    <span
      aria-hidden
      className={cn(
        "absolute right-0.5 top-0.5 size-1.5 rounded-full",
        progress.tone === "gave_up" ? "bg-red" : progress.tone === "fixing" ? "animate-pulse bg-accent motion-reduce:animate-none" : "bg-accent",
      )}
    />
  );
  return (
    <Popover
      side="top"
      align="start"
      width={344}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          data-treeboss-toggle
          data-treeboss={on || undefined}
          data-gate-tone={on ? progress.tone : undefined}
          aria-pressed={on}
          aria-label="Treeboss mode"
          title={TREEBOSS_TIP}
          disabled={disabled}
          className={cn(
            "relative flex size-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover disabled:opacity-40",
            on ? "text-accent" : "text-fg-muted",
            open && "bg-hover text-fg",
          )}
        >
          <TreePine className="size-3.5 shrink-0" />
          {dot}
        </button>
      }
    >
      <TreebossCard {...props} />
    </Popover>
  );
}

/**
 * The read-only status: the header (tier and gate count), the four gates with their detail, and the footer line. The card
 * shows it, and so does the off state's line. `on` false shows the off line instead of the gates.
 */
export function TreebossStatus({ state, on = true, action, children }: { state: TreebossViewState | null | undefined; on?: boolean; action?: ReactNode; children?: ReactNode }) {
  const progress = gateProgress(state);
  const count = progress.applicable > 0 ? `${progress.passed}/${progress.applicable} gates` : "no gates yet";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[length:var(--text-lg)] font-semibold text-fg">
          Treeboss · {on ? <span className="font-mono font-normal text-[length:var(--text-base)]">{tierLabel(state)}</span> : "off"}
        </div>
        {on && <span className="shrink-0 font-mono text-[length:var(--text-xs)] text-fg-muted">{count}</span>}
        {action}
      </div>
      {on ? (
        <>
          <ul className="flex flex-col gap-1">
            {gateRows(state).map((row) => (
              <GateLine key={row.id} row={row} />
            ))}
          </ul>
          <div className={cn("text-[length:var(--text-sm)]", progress.tone === "gave_up" ? "text-red" : "text-fg-muted")}>{gateFooter(state)}</div>
        </>
      ) : (
        <div className="text-[length:var(--text-sm)] text-fg-muted">Off. The gates run after each turn that changes files, once the mode is on.</div>
      )}
      {children}
    </div>
  );
}

/** The card: the status, the mode switch in its header, and the tier override. */
function TreebossCard({ on, disabled, onToggle, sessionId, state }: TreebossProps) {
  const tierSwitch = useMutation({
    mutationFn: (tier: Tier | null) => setSessionTreebossTier(sessionId!, tier),
    onError: (e: Error) => toast.error("Could not set the tier", { description: e.message }),
  });
  const tierValue: Tier | "auto" = state?.tier_source === "operator" && state.tier ? state.tier : "auto";
  const tierOff = !sessionId || tierSwitch.isPending;

  // The popover already insets its content (p-1.5), so the card adds no padding of its own: the menus beside it don't either.
  return (
    <TreebossStatus
      state={state}
      on={on}
      action={<Switch checked={on} onChange={() => onToggle()} disabled={disabled} label="Treeboss mode" />}
    >
      {on && (
        <div className="flex flex-col gap-1">
          <div className="text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Tier</div>
          <div className={cn(tierOff && "pointer-events-none opacity-50")}>
            <SegTabs<Tier | "auto">
              value={tierValue}
              onChange={(v) => tierSwitch.mutate(v === "auto" ? null : v)}
              items={[
                { value: "tweak", label: "tweak" },
                { value: "feature", label: "feature" },
                { value: "area", label: "area" },
                { value: "auto", label: "auto" },
              ]}
            />
          </div>
        </div>
      )}
    </TreebossStatus>
  );
}

function GateLine({ row }: { row: GateRow }) {
  return (
    <li className="flex items-start gap-2 rounded-md px-1 py-1">
      <GateGlyph status={row.status} />
      <span className="w-16 shrink-0 text-[length:var(--text-base)] text-fg">{row.label}</span>
      <span title={row.detail ?? undefined} className="min-w-0 flex-1 truncate text-[length:var(--text-sm)] text-fg-muted">
        {row.detail}
      </span>
    </li>
  );
}

/** The gate's result as a glyph and a word, so color is never the only signal. */
function GateGlyph({ status }: { status: GateRow["status"] }) {
  const common = "mt-px size-3.5 shrink-0";
  if (status === "pass") return <Check role="img" aria-label="pass" className={cn(common, "text-green")} />;
  if (status === "fail") return <X role="img" aria-label="fail" className={cn(common, "text-red")} />;
  if (status === "skip") return <Minus role="img" aria-label="skipped" className={cn(common, "text-fg-muted")} />;
  return <Dot role="img" aria-label="pending" className={cn(common, "text-fg-faint")} />;
}
