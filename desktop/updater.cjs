// Self-update from GitHub Releases (feed files latest*.yml are published by electron-builder).
// The updater owns a small state the window shows (status bar, toast, Settings > About): see web/src/lib/updates.ts.
const { app, ipcMain, shell } = require("electron");

const RELEASES_URL = "https://github.com/marius-pieptea/treeboss/releases/latest";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Can this build replace itself? Windows (NSIS) and the Linux AppImage can. macOS needs a signed app, and the Linux
 * tar.gz has no installer, so those only learn that a newer version exists and send the user to the release page.
 * Flip MAC_SIGNED once the mac build is signed and notarized (see electron-builder.yml).
 */
const MAC_SIGNED = false;
function canSelfInstall() {
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return !!process.env.APPIMAGE;
  if (process.platform === "darwin") return MAC_SIGNED;
  return false;
}

/** status: idle | checking | available | downloading | ready | current | error. */
const state = { status: "idle", version: app.getVersion(), latest: null, percent: 0, message: "", checkedAt: null, selfInstall: canSelfInstall(), enabled: false };
let autoUpdater = null;
let getWindow = () => null;

function set(patch) {
  Object.assign(state, patch);
  const w = getWindow();
  if (w && !w.isDestroyed()) w.webContents.send("update:changed", { ...state });
}

function check() {
  if (!autoUpdater || state.status === "checking" || state.status === "downloading") return Promise.resolve({ ...state });
  set({ status: "checking", message: "" });
  return autoUpdater
    .checkForUpdates()
    .catch(() => {})
    .then(() => ({ ...state }));
}

function registerIpc() {
  ipcMain.handle("update:state", () => ({ ...state }));
  ipcMain.handle("update:check", () => check());
  ipcMain.on("update:install", () => {
    if (autoUpdater && state.status === "ready") autoUpdater.quitAndInstall();
  });
  ipcMain.on("update:open-release", () => shell.openExternal(RELEASES_URL));
}

function startUpdater(getWin) {
  getWindow = getWin;
  registerIpc();
  // Dev runs and unpackaged builds have no feed; TRB_NO_UPDATE is the off switch.
  if (!app.isPackaged || process.env.TRB_NO_UPDATE) return;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return;
  }
  state.enabled = true;
  autoUpdater.autoDownload = state.selfInstall;
  autoUpdater.autoInstallOnAppQuit = state.selfInstall;

  autoUpdater.on("update-available", (info) => set({ status: state.selfInstall ? "downloading" : "available", latest: info.version, percent: 0, checkedAt: Date.now() }));
  autoUpdater.on("update-not-available", () => set({ status: "current", latest: null, checkedAt: Date.now() }));
  autoUpdater.on("download-progress", (p) => set({ status: "downloading", percent: Math.round(p.percent || 0) }));
  // On "Later" the update installs when the app quits (autoInstallOnAppQuit).
  autoUpdater.on("update-downloaded", (info) => set({ status: "ready", latest: info.version, percent: 100, checkedAt: Date.now() }));
  // A failed check (offline, rate limit, no feed yet) shows in About but never interrupts the user.
  autoUpdater.on("error", (e) => {
    console.error("update check failed:", e && e.message ? e.message : e);
    set({ status: "error", message: "Could not check for updates. Are you online?", checkedAt: Date.now() });
  });

  setTimeout(check, 15000);
  setInterval(check, CHECK_EVERY_MS).unref();
}

module.exports = { startUpdater };
