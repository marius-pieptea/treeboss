/** What the desktop shell reports about self-update (desktop/updater.cjs). */
export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "current" | "error";

export interface UpdateState {
  status: UpdateStatus;
  /** The running version. */
  version: string;
  /** The newer version, when there is one. */
  latest: string | null;
  percent: number;
  message: string;
  checkedAt: number | null;
  /** True when this build can download and install the update itself; false means a manual download. */
  selfInstall: boolean;
  /** False in dev runs and with TRB_NO_UPDATE: nothing is checked. */
  enabled: boolean;
}

/** One line for the status bar, or null when there is nothing to say. */
export function updateChip(s: UpdateState): string | null {
  if (!s.enabled) return null;
  switch (s.status) {
    case "ready": return `Restart to update to ${s.latest ?? "the new version"}`;
    case "downloading": return `Updating… ${s.percent}%`;
    case "available": return `${s.latest ?? "A new version"} is available`;
    default: return null;
  }
}

/** The sentence Settings > About shows under the version. */
export function updateSummary(s: UpdateState): string {
  if (!s.enabled) return "Update checks are off in this build.";
  switch (s.status) {
    case "checking": return "Checking for updates…";
    case "downloading": return `Downloading ${s.latest ?? "the update"}: ${s.percent}%`;
    case "ready": return `${s.latest ?? "The update"} is downloaded. Restart to install it.`;
    case "available": return `${s.latest ?? "A new version"} is available. This build updates by hand: download it from the release page.`;
    case "current": return "You are on the latest version.";
    case "error": return s.message || "Could not check for updates.";
    default: return s.checkedAt ? "You are on the latest version." : "Not checked yet.";
  }
}

/** Show a toast once per version and status, so a re-check does not nag. */
export function shouldNotify(prev: UpdateState | null, next: UpdateState): boolean {
  if (next.status !== "ready" && next.status !== "available") return false;
  return prev?.status !== next.status || prev?.latest !== next.latest;
}
