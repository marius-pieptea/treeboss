// Lets the page tell the shell its theme colors (Windows caption buttons) and light/dark mode, and tells the page about glass.
const { contextBridge, ipcRenderer } = require("electron");
const glass = (process.argv.find((a) => a.startsWith("--trb-glass=")) || "").slice("--trb-glass=".length);
contextBridge.exposeInMainWorld("treebossDesktop", {
  /** "mac" | "win" when the window has an OS frosted material behind it, "" otherwise. */
  glass,
  setAppearance: (source) => ipcRenderer.send("appearance", source),
  setTitleBarColors: (colors) => ipcRenderer.send("titlebar-colors", colors),
  /** A PNG (base64) of a rectangle of the window in CSS pixels, or null when it could not be taken. */
  capturePreview: (rect) => ipcRenderer.invoke("capture-preview", rect),
  /** Self-update. state() is { status, version, latest, percent, message, checkedAt, selfInstall, enabled }. */
  update: {
    state: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.send("update:install"),
    openRelease: () => ipcRenderer.send("update:open-release"),
    /** Calls back on every change; returns a function that stops listening. */
    onChange: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on("update:changed", h);
      return () => ipcRenderer.removeListener("update:changed", h);
    },
  },
});
