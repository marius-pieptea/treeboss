/**
 * Making the browser findable: the helper other parts of the UI call to open it, its palette commands, and a
 * one-time nudge when an agent starts using it while no browser tab is open.
 *
 * Everything here runs at import { liveSource, type LiveSource } from "@/lib/live";
import time because the browser must be discoverable before a browser tab exists.
 */
import { createElement } from "react";
import { liveSource, type LiveSource } from "@/lib/live";
import { Bot, Globe } from "lucide-react";
import { toast } from "sonner";
import { useUi, type Tab } from "@/lib/store";
import { useCommandStore } from "@/lib/commands";
import { AGENT_URL, isAgentUrl } from "./agent-logic";

export type BrowserMode = "preview" | "agent";

const browserTabs = (): Array<Extract<Tab, { kind: "browser" }>> => {
  const s = useUi.getState();
  const ws = s.current ? s.byWs[s.current] : null;
  return (ws?.tabs ?? []).filter((t): t is Extract<Tab, { kind: "browser" }> => t.kind === "browser");
};

/** Open (or focus) the browser in the given mode. Used by the palette, the title bar and the welcome screen. */
export function openBrowserTab(mode: BrowserMode = "preview"): void {
  const { openTab, activateTab } = useUi.getState();
  const existing = browserTabs().find((t) => (mode === "agent" ? isAgentUrl(t.url) : !isAgentUrl(t.url)));
  if (existing) return activateTab(existing.id);
  if (mode === "agent") void openTab({ kind: "browser", url: AGENT_URL, title: "Agent browser" });
  else void openTab({ kind: "browser", url: "", title: "Preview" });
}

function register(): void {
  useCommandStore.getState().set("browser", [
    { id: "browser-preview", group: "Browser", title: "Open preview", keywords: "dev server localhost web page iframe", icon: createElement(Globe), run: () => openBrowserTab("preview") },
    { id: "browser-agent", group: "Browser", title: "Open agent browser", keywords: "agent live view headless chrome watch", icon: createElement(Bot), run: () => openBrowserTab("agent") },
  ]);
}
register();

/* ---- the nudge ---------------------------------------------------------------------------------------- */

const nudged = new Set<string>();
let source: LiveSource | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

function connect(): void {
  if (source) return;
  source = liveSource("/api/stream");
  source.addEventListener("browser", (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { sessionId: string; rootId: string; url: string; action: string };
    if (nudged.has(d.rootId)) return;
    nudged.add(d.rootId);
    // Already watching it? Nothing to say.
    if (browserTabs().some((t) => isAgentUrl(t.url))) return;
    toast("An agent is using the browser", {
      description: d.action,
      duration: 12_000,
      action: {
        label: "Open agent browser",
        onClick: () => {
          useUi.getState().setActiveSession(d.rootId);
          openBrowserTab("agent");
        },
      },
    });
  });
  source.onerror = () => {
    source?.close();
    source = null;
    if (location.pathname.startsWith("/w/")) retry = setTimeout(connect, 3000);
  };
}

/** Listen only inside a workspace: before sign-in the stream would just be refused. */
function sync(): void {
  const inWorkspace = location.pathname.startsWith("/w/");
  if (inWorkspace) connect();
  else {
    source?.close();
    source = null;
    if (retry) clearTimeout(retry);
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("popstate", sync);
  sync();
}
