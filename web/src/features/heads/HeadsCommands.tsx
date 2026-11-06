import { GitMerge, Rocket, XCircle } from "lucide-react";
import { useRegisterCommands } from "@/lib/commands";
import { useSession } from "@/lib/queries";
import { useUi, useWs } from "@/lib/store";
import { countHeads } from "./model";
import { useHeadActions } from "./actions";
import { useSpawnDialog } from "./spawn-store";

/**
 * Palette commands for heads. Registered from whichever component mounts this; the shell should mount it once,
 * always, so the commands exist even when the Heads tab is not showing (see the report).
 */
export function HeadsCommands() {
  const ws = useWs();
  const session = useSession(ws.activeSession);
  const actions = useHeadActions();
  const heads = (session.data?.children ?? []).filter((h) => h.status !== "closed");
  const c = countHeads(heads);
  const lead = session.data?.session ?? null;

  useRegisterCommands(
    "heads",
    [
      { id: "heads-merge-ready", group: "Heads", title: "Merge all ready heads", icon: <GitMerge />, keywords: "hydra apply", when: () => c.ready > 0, run: () => actions.mergeAll(heads) },
      { id: "heads-close-finished", group: "Heads", title: "Close finished heads", icon: <XCircle />, when: () => heads.some((h) => h.status !== "running"), run: () => actions.closeFinished(heads) },
      {
        id: "heads-spawn",
        group: "Heads",
        title: "Spawn a head…",
        icon: <Rocket />,
        keywords: "subagent hydra new",
        when: () => !!lead,
        run: () => {
          useUi.getState().setRightTab("heads");
          useSpawnDialog.getState().show(lead?.id);
        },
      },
    ],
    [c.ready, heads.length, lead?.id],
  );
  return null;
}
