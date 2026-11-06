/**
 * Tells you when a session finishes while you are looking somewhere else: another panel, another tab, another
 * session. Started once from the panels that are always on screen at some point, and kept for the page's life.
 */
import { liveSource } from "@/lib/live";
import { toast } from "sonner";
import { get, url } from "@/lib/api";
import { useUi } from "@/lib/store";
import { drainOnTurnEnd } from "./queue-store";
import type { SessionView } from "@/lib/types";

let started = false;

export function ensureTurnWatcher(): void {
  if (started) return;
  started = true;
  const connect = () => {
    const es = liveSource("/api/stream");
    es.addEventListener("turn_end", async (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { sessionId: string; rootId: string; status: string };
      void drainOnTurnEnd(d);
      // Only the lead's turn is news; its heads finishing is part of the same story.
      if (d.sessionId !== d.rootId) return;
      const ui = useUi.getState();
      const ws = ui.current ? ui.byWs[ui.current] : null;
      const watching = ws?.activeSession === d.sessionId && ui.rightOpen && ui.rightTab === "agent" && document.visibilityState === "visible";
      if (watching) return;
      const detail = await get<{ session: SessionView }>(url.session(d.sessionId)).catch(() => null);
      if (!detail) return;
      const s = detail.session;
      const open = { label: "Open", onClick: () => {
        const u = useUi.getState();
        u.setActiveSession(s.id);
        u.setRightTab("agent");
      } };
      if (d.status === "failed") toast.error(`${s.title} failed`, { description: s.error?.split("\n")[0], action: open });
      else if (d.status === "cancelled") toast.message(`${s.title} was interrupted`, { action: open });
      else toast.success(`${s.title} finished`, { description: s.changes ? `${s.changes.files} file${s.changes.files === 1 ? "" : "s"} changed` : undefined, action: open });
    });
    es.onerror = () => {
      es.close();
      setTimeout(connect, 3000);
    };
  };
  connect();
}
