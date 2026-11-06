import { useUi } from "@/lib/store";
import { useTranscripts } from "./store";

/** Open the read-only replay of a session, scrolled to (and flashing) the turn that matched a search. */
export function openReplay(sessionId: string, seq: number | null = null, title = "Session replay"): void {
  useTranscripts.getState().open(sessionId, seq);
  const ui = useUi.getState();
  const id = ui.openTab({ kind: "transcripts", title });
  ui.updateTab(id, { title });
}
