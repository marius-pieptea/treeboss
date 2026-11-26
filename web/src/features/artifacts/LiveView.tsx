import { useEffect, useRef, useState, type JSX } from "react";
import { ChevronLeft, Globe, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { desktopBridge } from "@/features/browser/capture";
import { openBrowserTab } from "@/features/browser/discover";
import { post } from "@/lib/api";
import { useWs } from "@/lib/store";
import { cn } from "@/lib/utils";
import { isAllowedLiveUrl } from "./liveview-guard";

interface WebviewElement extends HTMLWebViewElement {
  canGoBack?: () => boolean;
  goBack?: () => void;
  reload?: () => void;
}

interface DesktopWebviewBridge {
  webview?: boolean;
}

/**
 * Live view for an artifact: on desktop, embeds claude.ai inside a persistent Electron <webview>;
 * on the web, navigates the active session's browser pane and opens it.
 */
export function LiveView({ url, onClose }: { url: string; onClose: () => void }): JSX.Element {
  const hasWebview = (desktopBridge() as DesktopWebviewBridge | null)?.webview === true;
  const allowed = isAllowedLiveUrl(url);

  const webviewRef = useRef<WebviewElement | null>(null);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [canBack, setCanBack] = useState(false);
  const [loading, setLoading] = useState(false);

  const ws = useWs();
  const sessionId = ws.activeSession;
  const sentRef = useRef<string | null>(null);
  const [fallbackError, setFallbackError] = useState<string | null>(null);

  useEffect(() => {
    setCurrentUrl(url);
    setCanBack(false);
  }, [url]);

  useEffect(() => {
    if (!hasWebview || !allowed) return;
    const el = webviewRef.current;
    if (!el) return;

    const syncCanBack = () => {
      try {
        setCanBack(Boolean(el.canGoBack?.()));
      } catch {
        // Electron <webview> methods throw if called before dom-ready (e.g., on early did-fail-load).
        setCanBack(false);
      }
    };
    const onNavigate = (e: Event & { url?: string }) => {
      if (typeof e.url === "string" && e.url) setCurrentUrl(e.url);
      syncCanBack();
    };
    const onStart = () => setLoading(true);
    const onStop = () => {
      setLoading(false);
      syncCanBack();
    };

    el.addEventListener("did-navigate", onNavigate);
    el.addEventListener("did-navigate-in-page", onNavigate);
    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-fail-load", onStop);
    return () => {
      el.removeEventListener("did-navigate", onNavigate);
      el.removeEventListener("did-navigate-in-page", onNavigate);
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-fail-load", onStop);
    };
  }, [hasWebview, allowed, url]);

  useEffect(() => {
    if (hasWebview || !allowed || !sessionId) return;
    const key = `${sessionId}:${url}`;
    if (sentRef.current === key) return;
    sentRef.current = key;
    setFallbackError(null);
    let cancelled = false;
    void post(`/api/browser/${encodeURIComponent(sessionId)}/input`, { kind: "navigate", url })
      .then(() => {
        if (!cancelled) openBrowserTab("agent");
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) setFallbackError(msg);
        toast.error(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [hasWebview, allowed, sessionId, url]);

  const callWebview = (fn: () => void) => {
    try {
      fn();
    } catch {
      // Electron <webview> methods throw if invoked before dom-ready.
    }
  };

  if (hasWebview) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col bg-bg">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
          <IconButton label="Back" size="icon" disabled={!allowed || !canBack} onClick={() => callWebview(() => webviewRef.current?.goBack?.())}>
            <ChevronLeft />
          </IconButton>
          <IconButton label="Reload" size="icon" disabled={!allowed} onClick={() => callWebview(() => webviewRef.current?.reload?.())}>
            <RotateCw className={cn(loading && "animate-spin-fast")} />
          </IconButton>
          <Input readOnly value={currentUrl} aria-label="Live view URL" className="h-7 min-w-0 flex-1 font-mono text-xs" />
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X />
            Close live view
          </Button>
        </div>
        {allowed ? (
          <webview ref={webviewRef} src={url} partition="persist:claude-ai" className="min-h-0 w-full flex-1 bg-panel" />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-fg-muted">
            Paste a link that starts with claude.ai/artifact/.
          </div>
        )}
      </div>
    );
  }

  let message: string;
  if (!sessionId) {
    message = "Open a session first to use the browser pane.";
  } else if (!allowed) {
    message = "Paste a link that starts with claude.ai/artifact/.";
  } else if (fallbackError) {
    message = fallbackError;
  } else {
    message = "Opened in the browser pane. Sign-ins there are kept for this project.";
  }

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 bg-bg px-6 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-raised text-fg-faint [&_svg]:size-5">
        <Globe />
      </div>
      <div className={cn("max-w-[36ch] text-xs leading-relaxed", fallbackError ? "text-red" : "text-fg-muted")}>{message}</div>
      <Button variant="ghost" size="sm" onClick={onClose}>
        <X />
        Close live view
      </Button>
    </div>
  );
}
