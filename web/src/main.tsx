import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import "./styles.css";
import { App } from "./App";
import { queryClient } from "@/lib/queries";
import { TooltipProvider } from "@/components/ui/overlay";
import { DialogHost } from "@/components/ui/dialogs";
import { HandoffDialog } from "@/features/agent/HandoffDialog";
import { registerCheckpointCommands } from "@/features/checkpoints/commands";
import { useUi } from "@/lib/store";
import { applyGlass, setNativeAppearance } from "@/lib/glass";
import { resolveTheme } from "@/lib/theme";

registerCheckpointCommands();

// Apply the stored theme to the store (the inline script in index.html already set the class).
useUi.getState().setTheme(useUi.getState().themePref);
// "System" themes follow the OS light/dark switch live.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const { themePref, setTheme } = useUi.getState();
  if (themePref === "system") setTheme(themePref);
});

// Desktop: the OS material (and native controls) follow the app's chosen mode, and the glass flag follows the toggle.
{
  const nativeMode = (p: ReturnType<typeof useUi.getState>["themePref"]) => (p === "system" ? "system" : resolveTheme(p, true).mode);
  let last = "";
  const sync = (s: ReturnType<typeof useUi.getState>) => {
    const key = `${s.themePref}|${s.glass}`;
    if (key === last) return;
    last = key;
    setNativeAppearance(nativeMode(s.themePref));
    applyGlass(s.glass);
  };
  sync(useUi.getState());
  useUi.subscribe(sync);
}

// The desktop app on macOS draws the window controls over the page (hidden title bar); styles.css keys off this.
if (/Electron\//.test(navigator.userAgent) && /Mac/.test(navigator.userAgent)) document.documentElement.dataset.desktop = "mac";
// On Windows the app draws the title bar and the system caption buttons sit over it: keep their colors on the theme.
if (/Electron\//.test(navigator.userAgent) && /Windows/.test(navigator.userAgent)) {
  const root = document.documentElement;
  root.dataset.desktop = "win";
  const sync = () => {
    const css = getComputedStyle(root);
    (window as any).treebossDesktop?.setTitleBarColors({ color: css.getPropertyValue("--bg").trim(), symbolColor: css.getPropertyValue("--fg").trim() });
  };
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
  sync();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
        <DialogHost />
        <HandoffDialog />
        <Toaster
          position="bottom-left"
          offset={{ bottom: 36, left: 56 }}
          toastOptions={{ classNames: { toast: "!bg-overlay !text-fg !border !border-line-strong !shadow-pop !text-[12.5px] !rounded-lg", description: "!text-fg-muted" } }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
