import { QaView } from "./QaView";
import { selectPlanOnOpen } from "./intent";
import { openBugs } from "@/features/lab/open";
import { openBrowserTab } from "@/features/browser/discover";
import { useBrowserPrefs } from "@/features/browser/prefs";
import { useWorkspace } from "@/lib/workspace";

export function QaTab() {
  const { root } = useWorkspace();
  const runInBrowser = (slug: string) => {
    selectPlanOnOpen(slug);
    useBrowserPrefs.getState().set({ qaOpen: true });
    openBrowserTab();
  };
  return <QaView root={root} onOpenBug={(finding) => openBugs({ finding })} onRunInBrowser={runInBrowser} />;
}
