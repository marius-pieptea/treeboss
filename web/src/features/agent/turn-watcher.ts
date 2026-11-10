/**
 * Tells you when a session finishes while you are looking somewhere else: another panel, another tab, another
 * session. Started once from the panels that are always on screen at some point, and kept for the page's life.
 */
import { liveSource } from "@/lib/live";
import { toast } from "sonner";
import { get, url } from "@/lib/api";
import { useUi } from "@/lib/store";
import { qk, queryClient } from "@/lib/queries";
import { drainOnTurnEnd } from "./queue-store";
import { openSessionIn } from "./agent-commands";
import type { SessionDetail, Workspace } from "@/lib/types";

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
      const detail = await get<SessionDetail>(url.session(d.sessionId)).catch(() => null);
      if (!detail) return;
      const s = detail.session;
      const wsId = detail.workspace_id ?? null;
      // A session from another workspace says where it is, and Open switches there before opening it.
      const elsewhere = wsId && wsId !== useUi.getState().current ? (queryClient.getQueryData<Workspace[]>(qk.workspaces)?.find((w) => w.id === wsId)?.name ?? "another workspace") : null;
      const describe = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" · ") || undefined;
      const where = elsewhere ? `in ${elsewhere}` : null;
      const open = { label: "Open", onClick: () => openSessionIn(wsId, s.id) };
      if (d.status === "failed") toast.error(`${s.title} failed`, { description: describe(where, s.error?.split("\n")[0]), action: open });
      else if (d.status === "cancelled") toast.message(`${s.title} was interrupted`, { description: describe(where), action: open });
      else toast.success(`${s.title} finished`, { description: describe(where, s.changes ? `${s.changes.files} file${s.changes.files === 1 ? "" : "s"} changed` : undefined), action: open });
    });
    es.onerror = () => {
      es.close();
      setTimeout(connect, 3000);
    };
  };
  connect();
}
