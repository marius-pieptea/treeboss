import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge, Spinner } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/form";
import { get } from "@/lib/api";
import { useEvidenceSwitches } from "./data";

const TOOLS = ["evidence_capture_page", "evidence_note", "evidence_list", "evidence_read"];

/** One line of REA's readiness, as GET /api/rea/readiness returns it. */
interface ReadinessCheck {
  id: string;
  level: "ok" | "warn" | "info";
  text: string;
  fix?: string;
}

interface ReadinessAnswer {
  enabled: boolean;
  report: { checks: ReadinessCheck[]; at: string; deep: boolean };
}

const READINESS_KEY = ["rea-readiness"] as const;

/** The readiness list: a quick read when the page opens, and the deep check (REA's own doctor) on the Check button. */
function useReaReadiness(reaOn: boolean) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: READINESS_KEY, queryFn: () => get<ReadinessAnswer>("/api/rea/readiness"), enabled: reaOn, retry: false });
  const check = useMutation({
    mutationFn: () => get<ReadinessAnswer>("/api/rea/readiness?deep=1&fresh=1"),
    onSuccess: (r) => qc.setQueryData(READINESS_KEY, r),
    onError: (e: Error) => toast.error(e.message),
  });
  return { query, check };
}

/** Settings > MCP: the two additions, both on by default: evidence tools (built in, part of `trb`) and REA (a third-party server). */
export function EvidenceMcpRows() {
  const { status, set } = useEvidenceSwitches();
  const reaOn = Boolean(status.data?.rea_mcp);
  const readiness = useReaReadiness(reaOn);
  if (!status.data) return null;
  return (
    <>
      <div className="rounded-xl border border-line bg-raised/40 p-3.5 animate-slide-up">
        <div className="flex items-center gap-2">
          <span className="font-mono text-base font-semibold">evidence</span>
          <Badge tone="accent">built in</Badge>
          <span className="min-w-0 flex-1 text-xs text-fg-muted">Lets agents capture the page open in the agent browser (HTML, styles, assets, requests, screenshot) and save findings that cite it, kept per project on this computer. On by default: a capture can include whatever a signed-in page showed.</span>
          <Switch checked={status.data.evidence} onChange={(on) => set.mutate({ key: "evidence", on })} label="Give sessions the evidence tools" />
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {TOOLS.map((t) => (
            <span key={t} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-xs text-fg-muted">
              {t}
            </span>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-line bg-raised/40 p-3.5 animate-slide-up">
        <div className="flex items-center gap-2">
          <span className="font-mono text-base font-semibold">rea</span>
          <Badge tone="amber">third party</Badge>
          <span className="min-w-0 flex-1 text-xs text-fg-muted">REA reverse-engineers binaries, Electron apps, APKs and websites and returns findings with their evidence. On by default, sessions download and run the pinned npm package rea-agents with npx; switch it off to stop offering it. Native analysis needs Ghidra, Hopper or IDA installed separately.</span>
          <Switch checked={status.data.rea_mcp} onChange={(on) => set.mutate({ key: "rea_mcp", on })} label="Offer REA to sessions" />
        </div>
        {reaOn && <ReaReadinessList query={readiness.query} check={readiness.check} />}
      </div>
    </>
  );
}

/** What REA can and cannot do here: warnings with the fix to copy, the found tools on one muted line. Never a failure: REA is optional. */
function ReaReadinessList({ query, check }: { query: ReturnType<typeof useReaReadiness>["query"]; check: ReturnType<typeof useReaReadiness>["check"] }) {
  const checkAgain = (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="subtle" onClick={() => check.mutate()} disabled={check.isPending}>
        {check.isPending && <Spinner />}
        Check again
      </Button>
      <span className="text-xs text-fg-muted">Runs REA's own doctor, which can take up to 90 s the first time (the package downloads then).</span>
    </div>
  );
  if (!query.data) {
    return (
      <div className="mt-2 flex flex-col gap-2 border-t border-line pt-2">
        {query.isPending ? <span className="flex items-center gap-2 text-xs text-fg-muted"><Spinner />Checking REA</span> : <span className="text-xs text-fg-muted">REA's readiness could not be read.</span>}
        {checkAgain}
      </div>
    );
  }
  const { checks } = query.data.report;
  const warns = checks.filter((c) => c.level === "warn");
  const infos = checks.filter((c) => c.level === "info");
  const oks = checks.filter((c) => c.level === "ok");
  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
      {warns.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone="amber">{c.id.startsWith("own") ? "failing" : "missing"}</Badge>
          <span className="text-fg">{c.text}</span>
          {c.fix && <span className="select-all rounded-sm border border-line bg-raised px-1.5 py-0.5 font-mono text-fg">{c.fix}</span>}
        </div>
      ))}
      {infos.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <Badge tone="neutral">info</Badge>
          <span>{c.text}</span>
          {c.fix && <span className="select-all font-mono">{c.fix}</span>}
        </div>
      ))}
      {oks.length > 0 && <span className="text-xs text-fg-muted">{oks.map((c) => c.text).join(" · ")}</span>}
      {checkAgain}
    </div>
  );
}
