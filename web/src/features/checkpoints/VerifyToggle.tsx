/**
 * This session's verification switch, in the session header beside Chat | Trace: a shield that is grey when off
 * and the accent colour when on. Clicking it flips the setting; the tooltip says what the project's checks said
 * about the last turn. Running the checks by hand and the link to Settings > Verification are in the session menu.
 */
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { get, post, put, url } from "@/lib/api";
import { qk } from "@/lib/queries";
import type { SessionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/overlay";
import { stripView, verifyBusy, type Tone } from "./logic";

const toneText: Record<Tone, string> = { accent: "text-accent", green: "text-green", amber: "text-amber", red: "text-red", neutral: "text-accent" };

interface SessionVerify {
  enabled: boolean;
  enabled_from: string;
  session_enabled: boolean | null;
  commands: Array<{ name: string; cmd: string }>;
}

/** This session's verification setting, the switch for it, and a manual run. Shared by the header icon and the session menu. */
export function useSessionVerify(session: SessionView | null) {
  const qc = useQueryClient();
  const id = session?.id ?? null;
  const q = useQuery({ queryKey: ["verify", id], enabled: !!id, queryFn: () => get<SessionVerify>(url.session(id!, "verify")), staleTime: 5000 });
  const state = session?.verify?.state;
  useEffect(() => {
    if (id) void qc.invalidateQueries({ queryKey: ["verify", id] });
  }, [id, state, qc]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["verify", id] });
    void qc.invalidateQueries({ queryKey: qk.session(id!) });
  };
  const toggle = useMutation({ mutationFn: (enabled: boolean) => put(url.session(id!, "verify"), { enabled }), onSuccess: refresh, onError: (e: Error) => toast.error("Could not change verification", { description: e.message }) });
  const run = useMutation({
    mutationFn: () => post<{ state: string }>(url.session(id!, "verify/run"), {}),
    onSuccess: (r) => {
      refresh();
      r.state === "passed" ? toast.success("Checks passed") : toast.message(`Checks: ${r.state}`);
    },
    onError: (e: Error) => toast.error("Could not run the checks", { description: e.message }),
  });
  const enabled = q.data?.enabled ?? false;
  const canRun = !!session && enabled && !verifyBusy(state) && !run.isPending && session.status === "idle" && !!q.data?.commands.length;
  return { q, toggle, run, enabled, canRun };
}

export function VerifyToggle({ session, verify }: { session: SessionView; verify: ReturnType<typeof useSessionVerify> }) {
  const { q, toggle, enabled } = verify;
  const view = enabled ? stripView(session) : null;
  const Icon = !view ? ShieldCheck : view.tone === "green" ? Check : view.tone === "red" || view.tone === "amber" ? CircleAlert : view.tone === "accent" ? Loader2 : ShieldCheck;
  const from = q.data?.enabled_from && q.data.enabled_from !== "default" ? ` (set by ${q.data.enabled_from})` : "";
  const tip = view ? (
    <span className="block max-w-[260px]">
      <span className="block font-medium">{view.label}</span>
      {view.detail && <span className="block text-fg-muted">{view.detail}</span>}
      <span className="block text-fg-muted">Click to turn off{from}</span>
    </span>
  ) : enabled ? (
    `Verification on: checks run after each turn. Click to turn off${from}`
  ) : (
    `Verification off. Click to check this session's work after each turn${from}`
  );
  return (
    <Tooltip label={tip} side="top">
      <button
        type="button"
        data-verify-toggle={enabled ? "on" : "off"}
        data-verify-state={session.verify?.state ?? "none"}
        data-done={session.done ? "true" : "false"}
        aria-label="Verify this session"
        aria-pressed={enabled}
        disabled={!q.data || toggle.isPending}
        onClick={() => toggle.mutate(!enabled)}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded outline-none transition-colors hover:bg-hover focus-visible:bg-hover disabled:opacity-50",
          view ? toneText[view.tone] : enabled ? "text-accent" : "text-fg-faint hover:text-fg-muted",
        )}
      >
        <Icon className={cn("size-4", view?.tone === "accent" && "animate-spin")} />
      </button>
    </Tooltip>
  );
}
