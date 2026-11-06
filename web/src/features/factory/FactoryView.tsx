import { useContext } from "react";
import { Factory } from "lucide-react";
import { Empty, SegTabs } from "@/components/ui/misc";
import { useUi, type FactoryPage, type Tab } from "@/lib/store";
import { WorkspaceContext } from "@/lib/workspace";
import { PortfolioView } from "@/features/products/PortfolioView";
import { ContextStrip } from "./ContextStrip";
import { AutopilotPanel } from "@/features/autopilot/AutopilotPanel";
import { SchedulesEditor } from "@/features/autopilot/SchedulesEditor";
import { PrPanel } from "@/features/ci/PrPanel";
import { DeployView } from "@/features/deploy/DeployView";
import { ReleasesView } from "@/features/releases/ReleasesView";
import { PracticesPanel } from "@/features/practices/PracticesPanel";
import { MobilePanel } from "@/features/mobile/MobilePanel";
import { SignalsInbox } from "@/features/signals/SignalsInbox";
import { SecretsPanel } from "@/features/secrets/SecretsPanel";

const PAGES: Array<{ value: FactoryPage; label: string }> = [
  { value: "portfolio", label: "Portfolio" },
  { value: "autopilot", label: "Autopilot" },
  { value: "ship", label: "Ship" },
  { value: "releases", label: "Releases" },
  { value: "practices", label: "Practices" },
  { value: "mobile", label: "Mobile" },
  { value: "signals", label: "Signals" },
  { value: "secrets", label: "Secrets" },
];

/** The factory: the products, autopilot, shipping, mobile, signals and secrets, one tab with a page for each. */
export function FactoryView({ tab }: { tab: Extract<Tab, { kind: "factory" }> }) {
  const ws = useContext(WorkspaceContext);
  const updateTab = useUi((s) => s.updateTab);
  // A saved tab can name a page that is gone: show Portfolio rather than an empty body.
  const page = PAGES.some((p) => p.value === tab.page) ? tab.page : "portfolio";
  const setPage = (p: FactoryPage) => updateTab(tab.id, { page: p });

  // Portfolio is across products, so it opens with no workspace. The rest act on the open workspace.
  const needsWorkspace = page !== "portfolio";
  const noWorkspace = needsWorkspace && !ws;

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      {ws && <ContextStrip workspaceId={ws.root} workspaceName={ws.workspace.name} page={page} onAllProducts={() => setPage("portfolio")} />}
      <div className="shrink-0 overflow-x-auto border-b border-line px-3 py-2">
        <SegTabs value={page} onChange={setPage} items={PAGES} />
      </div>
      {noWorkspace ? (
        <Empty icon={<Factory />} title="No workspace open" hint="Open a workspace to use this page." className="h-full" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {page === "portfolio" && <PortfolioView />}
          {page === "autopilot" && ws && (
            <div className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1">
                <AutopilotPanel workspaceId={ws.root} />
              </div>
              <div className="max-h-[40%] shrink-0 overflow-auto border-t border-line">
                <SchedulesEditor workspaceId={ws.root} />
              </div>
            </div>
          )}
          {page === "ship" && ws && (
            <div className="divide-y divide-line">
              <PrPanel workspaceId={ws.root} />
              <DeployView root={ws.root} />
            </div>
          )}
          {page === "releases" && ws && <ReleasesView root={ws.root} />}
          {page === "practices" && ws && <PracticesPanel />}
          {page === "mobile" && <MobilePanel />}
          {page === "signals" && <SignalsInbox />}
          {page === "secrets" && <SecretsPanel />}
        </div>
      )}
    </div>
  );
}
