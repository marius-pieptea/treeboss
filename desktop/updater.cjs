// Self-update from GitHub Releases (feed files latest*.yml are published by electron-builder).
const { app, dialog, shell } = require("electron");

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

function startUpdater(getWindow) {
  // Dev runs and unpackaged builds have no feed; TRB_NO_UPDATE is the off switch.
  if (!app.isPackaged || process.env.TRB_NO_UPDATE) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return;
  }
  const selfInstall = canSelfInstall();
  autoUpdater.autoDownload = selfInstall;
  autoUpdater.autoInstallOnAppQuit = selfInstall;
  let announced = "";
  const parent = () => {
    const w = getWindow();
    return w && !w.isDestroyed() ? w : undefined;
  };
  const ask = (options) => (parent() ? dialog.showMessageBox(parent(), options) : dialog.showMessageBox(options));

  autoUpdater.on("update-available", async (info) => {
    if (selfInstall || announced === info.version) return;
    announced = info.version;
    const r = await ask({
      type: "info",
      message: `TreeBoss ${info.version} is available`,
      detail: `You have ${app.getVersion()}. This build updates by hand: download the new version from the release page.`,
      buttons: ["Open release page", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) shell.openExternal(RELEASES_URL);
  });
  autoUpdater.on("update-downloaded", async (info) => {
    const r = await ask({
      type: "info",
      message: `TreeBoss ${info.version} is ready`,
      detail: "Restart to finish updating. Running turns stop when the app restarts.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    // On "Later" the update installs when the app quits (autoInstallOnAppQuit).
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  // A failed check (offline, rate limit, no feed yet) is not worth interrupting the user for.
  autoUpdater.on("error", (e) => console.error("update check failed:", e && e.message ? e.message : e));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15000);
  setInterval(check, CHECK_EVERY_MS).unref();
}

module.exports = { startUpdater };
