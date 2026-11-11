import { Download, RefreshCw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Spinner } from "@/components/ui/misc";
import { hasUpdater, useUpdate } from "@/lib/updates";
import { updateSummary } from "@/lib/updates-logic";
import { Card, PageShell } from "./shared";

/** The running version and the update controls. Updates are the desktop app's job; a browser tab has nothing to check. */
export function AboutPage() {
  const { state, check, install, openRelease } = useUpdate();
  const busy = state?.status === "checking" || state?.status === "downloading";

  return (
    <PageShell title="About TreeBoss" description="The version you are running and whether a newer one is out.">
      {!hasUpdater() ? (
        <Card className="p-4 text-[13px] text-fg-muted">You are using TreeBoss in a browser. Updates are installed by the desktop app, which checks GitHub Releases on its own.</Card>
      ) : (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-fg-muted">Version</span>
            <span className="font-mono text-[13px] text-fg">{state?.version ?? "…"}</span>
            {state?.status === "ready" && <Badge tone="green">update ready</Badge>}
            {state?.status === "available" && <Badge tone="blue">new version</Badge>}
          </div>
          <p className="flex items-center gap-2 text-[13px] text-fg-muted" aria-live="polite">
            {busy && <Spinner />}
            {state ? updateSummary(state) : "Loading…"}
          </p>
          {state?.checkedAt && <p className="font-mono text-[11px] text-fg-faint">Last checked {new Date(state.checkedAt).toLocaleString()}</p>}
          <div className="flex items-center gap-2">
            {state?.status === "ready" ? (
              <Button variant="primary" onClick={install}>
                <RotateCw /> Restart and update
              </Button>
            ) : state?.status === "available" ? (
              <Button variant="primary" onClick={openRelease}>
                <Download /> Open release page
              </Button>
            ) : null}
            <Button onClick={check} disabled={busy || !state?.enabled}>
              <RefreshCw /> Check for updates
            </Button>
          </div>
        </Card>
      )}
    </PageShell>
  );
}
