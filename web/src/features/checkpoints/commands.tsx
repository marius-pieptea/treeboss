/** Palette commands for checkpoints and verification. Registered once for the page's life, like the agent's. */
import { History, ShieldCheck } from "lucide-react";
import { useCommandStore, type Command } from "@/lib/commands";
import { queryClient } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { useThreadFocus } from "./ThreadActions";
import type { CheckpointRow, TurnBrief } from "./logic";

const activeSessionId = (): string | null => {
  const s = useUi.getState();
  return s.current ? (s.byWs[s.current]?.activeSession ?? null) : null;
};

/** Open the Verification page in Settings. */
export function openVerifySettings(): void {
  useUi.getState().openTab({ kind: "settings", page: "verify", title: "Verification" });
}

const commands: Command[] = [
  {
    id: "checkpoints-open",
    group: "Agent",
    title: "Rewind or fork from a turn…",
    icon: <History />,
    keywords: "checkpoint rewind undo revert fork branch turn restore",
    when: () => !!activeSessionId(),
    // The actions live on the messages: bring the newest turn's buttons into view and focus them.
    run: () => {
      const id = activeSessionId();
      const data = id ? queryClient.getQueryData<{ turns: TurnBrief[]; checkpoints: CheckpointRow[] }>(["checkpoints", id]) : undefined;
      const turn = data?.turns.length ? data.turns.reduce((a, b) => (b.seq > a.seq ? b : a)) : null;
      if (turn) useThreadFocus.getState().focus(turn.id);
    },
  },
  {
    id: "settings-verify",
    group: "Settings",
    title: "Verification settings…",
    icon: <ShieldCheck />,
    keywords: "verify typecheck lint test checks retries done timeout commands",
    run: openVerifySettings,
  },
];

let registered = false;
export function registerCheckpointCommands(): void {
  if (registered) return;
  registered = true;
  useCommandStore.getState().set("checkpoints", commands);
}
