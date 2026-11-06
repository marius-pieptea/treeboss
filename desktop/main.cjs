// TreeBoss desktop shell: starts the bundled daemon, signs the window in, shows the UI.
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, nativeTheme } = require("electron");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const win32 = process.platform === "win32";
const target = `${win32 ? "windows" : process.platform}-${process.arch}`;
const exeName = win32 ? "trb.exe" : "trb";
const stageDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "stage");
const trb = path.join(stageDir, "bin", app.isPackaged ? "" : target, exeName);
const webDir = path.join(stageDir, "web");
const packsDir = path.join(stageDir, "packs");
const trbHome = process.env.TRB_HOME ? path.resolve(process.env.TRB_HOME) : path.join(os.homedir(), ".treeboss");

/**
 * The frosted material behind the window: "mac" (vibrancy), "win" (acrylic, Windows 11 22H2+) or "" (solid).
 * The page gets this through the preload and only goes translucent when it is non-empty.
 */
function glassKind() {
  if (process.env.TRB_NO_GLASS) return "";
  if (nativeTheme.prefersReducedTransparency) return "";
  if (process.platform === "darwin") return "mac";
  if (win32 && Number(os.release().split(".")[2]) >= 22621) return "win";
  return "";
}

let win = null;

/** A GUI app on macOS/Linux gets a bare PATH; the engines (claude, codex…) live on the login shell's. */
function fixPath() {
  if (win32) return;
  try {
    const sh = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(sh, ["-ilc", 'printf "%s" "$PATH"'], { encoding: "utf8", timeout: 5000 });
    const login = out.split("\n").pop();
    if (login) process.env.PATH = [...new Set([...login.split(":"), ...(process.env.PATH || "").split(":")])].join(":");
  } catch {}
}

// The daemon stops itself when this process goes (crash, force-quit, installer), so pass our pid along.
const daemonEnv = () => ({ ...process.env, TRB_WEB_DIR: webDir, TRB_PACKS_DIR: packsDir, TRB_OWNER_PID: String(process.pid) });
const trbRun = (args) => spawnSync(trb, args, { env: daemonEnv(), encoding: "utf8", windowsHide: true, timeout: 30000 });

/**
 * The app owns the daemon: it starts with the app and stops with it. On launch it restarts rather than reuses,
 * so the daemon (and the engines it spawns) get this launch's environment, not a stale one from before a re-login.
 * A daemon left running by a previous launch would otherwise keep that old environment.
 */
async function startDaemon({ fresh = false } = {}) {
  if (!fs.existsSync(trb)) throw new Error(`The bundled daemon is missing: ${trb}`);
  const r = trbRun(["daemon", fresh ? "restart" : "start"]);
  if (r.status !== 0) throw new Error(`The daemon did not start.\n${r.stdout || ""}${r.stderr || ""}\nLog: ${path.join(trbHome, "logs", "daemon.log")}`);
  const info = JSON.parse(fs.readFileSync(path.join(trbHome, "daemon.json"), "utf8"));
  const token = fs.readFileSync(path.join(trbHome, "token"), "utf8").trim();
  return { url: info.url, token };
}

async function signInUrl({ url, token }, to = "/") {
  const res = await fetch(`${url}/api/ui/ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}).`);
  const { ticket } = await res.json();
  return `${url}/_auth?ticket=${ticket}&to=${encodeURIComponent(to)}`;
}

/** The arguments that name a path: Explorer's "Open with TreeBoss" and file associations pass one. Packaged apps start at argv[1]. */
function pathArgs(argv) {
  return argv.slice(app.isPackaged ? 1 : 2);
}

/** The folder to open for the first path argument: the folder itself, or the folder holding a file. */
function folderFrom(args, cwd) {
  for (const arg of args) {
    // Explorer passes %V ending in a backslash before the closing quote ("C:\dir\"), which Windows reads as an escaped quote.
    const p = path.resolve(cwd, arg.replace(/"+$/, ""));
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) return p;
      if (st.isFile()) return path.dirname(p);
    } catch {}
  }
  return null;
}

/** Registers the folder as a workspace on the daemon and returns the page that shows it. */
async function workspaceRoute({ url, token }, dir) {
  const res = await fetch(`${url}/api/workspaces`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ path: dir }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not open ${dir} (${res.status}).`);
  return `/w/${data.workspace.id}`;
}

/** Shows the folder in the open window, or opens a window on it. */
async function openFolder(dir) {
  if (!win) return openWindow({ dir });
  const conn = await startDaemon();
  const to = await workspaceRoute(conn, dir);
  await win.loadURL(await signInUrl(conn, to));
  if (win.isMinimized()) win.restore();
  win.focus();
}

async function openWindow({ fresh = false, dir } = {}) {
  const conn = await startDaemon({ fresh });
  const to = dir ? await workspaceRoute(conn, dir) : "/";
  const glass = glassKind();
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    // With glass the window itself is clear so the OS material shows; the page tints it (--glass in styles.css).
    backgroundColor: glass ? "#00000000" : "#0b0d10",
    ...(glass === "mac" ? { vibrancy: "sidebar", visualEffectState: "followWindow" } : {}),
    ...(glass === "win" ? { backgroundMaterial: "acrylic" } : {}),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : win32 ? "hidden" : "default",
    // Windows: the app draws its own title bar and the system caption buttons sit over it; their colors follow the theme.
    ...(win32 ? { titleBarOverlay: { color: glass ? "#00000000" : "#090b0e", symbolColor: "#d8dee7", height: 40 } } : {}),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "preload.cjs"), additionalArguments: [`--trb-glass=${glass}`] },
  });
  if (win32) win.removeMenu();
  // Links to other sites open in the browser; the app stays on the daemon's origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(conn.url)) shell.openExternal(url);
    return { action: url.startsWith(conn.url) ? "allow" : "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(conn.url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on("closed", () => (win = null));
  await win.loadURL(await signInUrl(conn, to));
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
// A second launch (say, "Open with TreeBoss" on another folder) hands its arguments to this instance.
app.on("second-instance", (_e, argv, cwd) => {
  const dir = folderFrom(pathArgs(argv), cwd);
  if (dir) {
    openFolder(dir).catch((e) => dialog.showErrorBox("TreeBoss", String(e.message || e)));
  } else if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// The OS material and native controls follow the app's light/dark choice ("system" follows the OS).
ipcMain.on("appearance", (e, source) => {
  if (source === "system" || source === "light" || source === "dark") nativeTheme.themeSource = source;
});

ipcMain.on("titlebar-colors", (e, c) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const ok = (v) => typeof v === "string" && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\))$/i.test(v.trim());
  if (win32 && w && c && ok(c.color) && ok(c.symbolColor)) w.setTitleBarOverlay({ color: glassKind() ? "#00000000" : c.color.trim(), symbolColor: c.symbolColor.trim(), height: 40 });
});

// A pixel-exact capture of the preview pane, for the bug log: the iframe is cross-origin, so only the window can see it.
ipcMain.handle("capture-preview", async (e, rect) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return null;
  const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!rect || !finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height) || !rect.width || !rect.height) return null;
  try {
    const image = await win.webContents.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
    return image.toPNG().toString("base64");
  } catch {
    return null;
  }
});

app.whenReady().then(async () => {
  // The losing instance quits; it must not restart the daemon the first instance is running.
  if (!lock) return;
  fixPath();
  // Windows has no menu bar at all: the File / Edit / View / Window strip is not wanted there.
  Menu.setApplicationMenu(
    win32 ? null : Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  try {
    await openWindow({ fresh: true, dir: folderFrom(pathArgs(process.argv), process.cwd()) });
  } catch (err) {
    dialog.showErrorBox("TreeBoss could not start", String(err && err.message ? err.message : err));
    app.quit();
  }
});

app.on("activate", () => {
  if (!win && app.isReady()) openWindow().catch((e) => dialog.showErrorBox("TreeBoss", String(e.message || e)));
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  // Quitting the app stops its daemon, and any live turns with it.
  trbRun(["daemon", "stop"]);
});
