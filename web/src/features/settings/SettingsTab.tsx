import { lazy, Suspense } from "react";
import type { Tab } from "@/lib/store";
import { Spinner } from "@/components/ui/misc";
import { AgentsPage } from "./AgentsPage";
import { ConfigPage } from "./ConfigPage";
import { EnginesPage } from "./EnginesPage";
import { McpPage } from "./McpPage";
import { PairsPage } from "./PairsPage";
import { WorkspacePage } from "./WorkspacePage";
import { RemotePage } from "./RemotePage";
import { VerifyPage } from "@/features/checkpoints/VerifyPage";
import { TemplatesPage } from "@/features/scaffold/TemplatesPage";
import { SystemsPage } from "@/features/design/SystemsPage";
import { ChecklistsPage } from "./ChecklistsPage";
import { PracticesEditor } from "@/features/practices/PracticesEditor";
import { PageShell } from "./shared";

// The skills page carries a code editor; load it only when someone opens it.
const SkillsPage = lazy(() => import("./SkillsPage").then((m) => ({ default: m.SkillsPage })));

export function SettingsTab({ tab }: { tab: Extract<Tab, { kind: "settings" }> }) {
  switch (tab.page) {
    case "agents":
      return <AgentsPage />;
    case "pairs":
      return <PairsPage />;
    case "mcp":
      return <McpPage />;
    case "skills":
      return (
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner className="size-5" /></div>}>
          <SkillsPage />
        </Suspense>
      );
    case "engines":
      return <EnginesPage />;
    case "config":
      return <ConfigPage />;
    case "workspace":
      return <WorkspacePage />;
    case "remote":
      return <RemotePage />;
    case "verify":
      return <VerifyPage />;
    case "templates":
      return <TemplatesPage />;
    case "design-systems":
      return <SystemsPage />;
    case "checklists":
      return <ChecklistsPage />;
    case "practices":
      return (
        <PageShell title="Practices" description="Rules, checks and skills every agent follows. Each workspace turns packs on, sets what a finding does, and can switch single rules or checks off." wide>
          <PracticesEditor />
        </PageShell>
      );
  }
}
