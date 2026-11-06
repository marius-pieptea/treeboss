/**
 * Saved sign-ins for the agent browser. Each root session's browser is a fresh, isolated context, so without
 * this a login made in the live view (or by the agent) is gone as soon as the context closes: idle for ten
 * minutes, evicted, a new session, a daemon restart. Here the cookies and local storage of a context are kept
 * per project (the same key evidence uses) and put back into the next context of that project.
 *
 * The file is a secret: it holds session cookies. It lives in the trb home with mode 0600, is never part of
 * evidence (captures read the page only), and `browser_signins off` or `clearSignins` stops or removes it.
 *
 * Several contexts of one project can be open at once, so saving merges with what is on disk instead of
 * overwriting it: an older context cannot wipe a login another one just made, and a cookie this context loaded
 * and then lost (a logout) is removed rather than brought back.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { paths } from "../paths";
import { getSetting } from "../settings";
import { workspaceKey } from "../evidence/store";

/** Playwright's own storage-state shape, so a saved file goes straight back into `newContext`. */
export type SignInState = Awaited<ReturnType<import("playwright-core").BrowserContext["storageState"]>>;
export type SavedCookie = SignInState["cookies"][number];
export type SavedOrigin = SignInState["origins"][number];

export const signinsEnabled = (): boolean => getSetting("browser_signins") === "on";

export const cookieKey = (c: Pick<SavedCookie, "name" | "domain" | "path">): string => `${c.name}\0${c.domain}\0${c.path}`;

function fileFor(workspace: string): string {
  const key = crypto.createHash("sha256").update(workspaceKey(workspace)).digest("hex").slice(0, 24);
  return path.join(paths.browserSignins(), `${key}.json`);
}

/** A session cookie has expires -1; anything else in the past is dead. */
const alive = (c: SavedCookie, now: number): boolean => c.expires === -1 || c.expires > now / 1000;

/**
 * What to write: the context's current state laid over the disk's. `loaded` is what the context started with, so
 * cookies it dropped on purpose can be told apart from cookies it never had.
 */
export function mergeState(disk: SignInState | null, loaded: SignInState | null, current: SignInState, now = Date.now()): SignInState {
  const lost = new Set((loaded?.cookies ?? []).map(cookieKey));
  for (const c of current.cookies) lost.delete(cookieKey(c));
  const cookies = new Map<string, SavedCookie>();
  for (const c of disk?.cookies ?? []) if (!lost.has(cookieKey(c))) cookies.set(cookieKey(c), c);
  for (const c of current.cookies) cookies.set(cookieKey(c), c);
  const origins = new Map<string, SavedOrigin>();
  for (const o of disk?.origins ?? []) origins.set(o.origin, o);
  for (const o of current.origins) origins.set(o.origin, o);
  return { cookies: [...cookies.values()].filter((c) => alive(c, now)), origins: [...origins.values()] };
}

function parse(raw: string): SignInState | null {
  try {
    const v = JSON.parse(raw);
    if (v && Array.isArray(v.cookies) && Array.isArray(v.origins)) return { cookies: v.cookies, origins: v.origins };
  } catch {}
  return null;
}

/** The saved state for a project, or null (none saved, unreadable, or the setting is off). */
export function loadSignins(workspace: string): SignInState | null {
  if (!signinsEnabled()) return null;
  try {
    const s = parse(fs.readFileSync(fileFor(workspace), "utf8"));
    return s && { ...s, cookies: s.cookies.filter((c) => alive(c, Date.now())) };
  } catch {
    return null;
  }
}

/** Merge `current` into the project's file. Atomic (temp file, then rename) and 0600. */
export function saveSignins(workspace: string, loaded: SignInState | null, current: SignInState): void {
  if (!signinsEnabled()) return;
  const file = fileFor(workspace);
  let disk: SignInState | null = null;
  try {
    disk = parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const merged = mergeState(disk, loaded, current);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Forget a project's saved sign-ins. */
export function clearSignins(workspace: string): boolean {
  try {
    fs.rmSync(fileFor(workspace));
    return true;
  } catch {
    return false;
  }
}
