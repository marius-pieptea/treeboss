/**
 * `trb mobile`: the Expo and EAS pipeline from a terminal. The daemon does the work; this prints it.
 *
 *   trb mobile [show] [--json]                          the app: Expo, platforms, bundle id, profiles, store listing issues, recent builds
 *   trb mobile metadata [--json]                        check store/metadata.json (name, subtitle, keywords, description, privacy URL)
 *   trb mobile build [--platform ios|android|all] [--profile P]   queue cloud builds (defaults: all, production)
 *   trb mobile builds [--json]                          recent builds with their status
 *   trb mobile submit --platform ios|android --profile P          submit the latest finished build (TestFlight, Play internal)
 *   trb mobile update --branch B -m "<message>"         publish an over-the-air update
 *   trb mobile preview [--json]                         the Expo Go URL and a QR code (starts expo start --tunnel)
 *
 * Cloud commands need EXPO_TOKEN in the workspace's secrets.
 */
import path from "path";
import { opts } from "../args";
import { api } from "../client";
import { c, die, printJson, table, ago } from "../fmt";
import { qrText } from "../../remote/qr";

const USAGE = `trb mobile [show|metadata|build|builds|submit|update|preview] [--platform P] [--profile P] [--branch B] [-m "<message>"] [--json]`;

interface Build {
  id: string;
  platform: string;
  profile: string;
  easBuildId: string | null;
  status: string;
  artifactUrl: string | null;
  version: string | null;
  buildNumber: string | null;
  createdAt: string;
}

interface Issue {
  field: string;
  problem: string;
}

interface Mobile {
  detect: { isExpo: boolean; name: string | null; sdkVersion: string | null; platforms: string[]; bundleId: string | null; androidPackage: string | null; profiles: string[]; submitProfiles: string[]; notes: string[] };
  metadata: { path: string; present: boolean; issues: Issue[] };
  builds: Build[];
  submissions: Array<{ platform: string; profile: string; status: string; createdAt: string }>;
}

async function workspaceRoot(dir = process.cwd()): Promise<string> {
  const r = await api<{ workspace: { id: string } }>("POST", "/api/workspaces", { path: path.resolve(dir) });
  return r.workspace.id;
}

const STATUS: Record<string, (s: string) => string> = {
  finished: c.green,
  errored: c.red,
  canceled: c.gray,
  new: c.cyan,
  in_queue: c.cyan,
  in_progress: c.cyan,
};

function buildRows(builds: Build[]): string {
  if (!builds.length) return c.dim("no builds yet: trb mobile build");
  const rows = builds.map((b) => [
    c.dim(b.id.slice(-8)),
    b.platform,
    b.profile,
    (STATUS[b.status] ?? ((s: string) => s))(b.status.replace(/_/g, " ")),
    [b.version, b.buildNumber ? `(${b.buildNumber})` : null].filter(Boolean).join(" ") || "",
    b.artifactUrl ? c.dim("artifact ready") : "",
    c.dim(ago(b.createdAt)),
  ]);
  return table(rows, ["ID", "PLATFORM", "PROFILE", "STATUS", "VERSION", "", "CREATED"]);
}

function showIssues(issues: Issue[]): void {
  if (!issues.length) console.log(c.green("store listing: ok"));
  for (const i of issues) console.log(`${c.yellow("!")} ${c.bold(i.field)}: ${i.problem}`);
}

export async function cmdMobile(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, {
    platform: { type: "string" },
    profile: { type: "string" },
    branch: { type: "string" },
    message: { type: "string", short: "m" },
    json: { type: "boolean" },
  });
  const sub = positionals[0] ?? "show";
  const root = await workspaceRoot();
  const base = `/api/mobile/${root}`;

  switch (sub) {
    case "show": {
      const m = await api<Mobile>("GET", base);
      if (values.json) return printJson(m);
      const d = m.detect;
      if (!d.isExpo) {
        console.log(c.dim("not an Expo project (no expo dependency, app.json expo key, app.config.*, or eas.json)"));
        return 0;
      }
      console.log(`${c.bold(d.name ?? "Expo app")}${d.sdkVersion ? c.dim(`   expo ${d.sdkVersion}`) : ""}`);
      console.log(`platforms   ${d.platforms.join(", ") || c.dim("none")}`);
      console.log(`bundle id   ${d.bundleId ?? c.dim("not set")}`);
      console.log(`android     ${d.androidPackage ?? c.dim("not set")}`);
      console.log(`profiles    ${d.profiles.join(", ") || c.dim("none in eas.json")}`);
      console.log(`submit      ${d.submitProfiles.join(", ") || c.dim("none in eas.json")}`);
      for (const n of d.notes) console.log(c.dim(`note: ${n}`));
      console.log(`\n${c.bold("store listing")}`);
      showIssues(m.metadata.issues);
      console.log(`\n${c.bold("builds")}`);
      console.log(buildRows(m.builds));
      return 0;
    }
    case "metadata": {
      const m = await api<Mobile>("GET", base);
      if (values.json) return printJson(m.metadata);
      showIssues(m.metadata.issues);
      return m.metadata.issues.length ? 1 : 0;
    }
    case "build": {
      const r = await api<{ builds: Build[] }>("POST", `${base}/builds`, { platform: values.platform ?? "all", profile: values.profile ?? "production" });
      if (values.json) return printJson(r);
      console.log(buildRows(r.builds));
      return 0;
    }
    case "builds": {
      const r = await api<{ builds: Build[] }>("GET", `${base}/builds`);
      if (values.json) return printJson(r);
      console.log(buildRows(r.builds));
      return 0;
    }
    case "submit": {
      if (!values.platform || !values.profile) die("submit needs --platform ios|android and --profile <submit profile>");
      const r = await api<{ submission: { status: string; detail: string | null } }>("POST", `${base}/submit`, { platform: values.platform, profile: values.profile });
      if (values.json) return printJson(r);
      console.log(`${c.green("submitted")} ${values.platform} (${values.profile})`);
      if (r.submission.detail) console.log(c.dim(r.submission.detail));
      return 0;
    }
    case "update": {
      if (!values.branch || !values.message) die("update needs --branch <name> and -m \"<message>\"");
      const r = await api<{ output: string }>("POST", `${base}/update`, { branch: values.branch, message: values.message });
      if (values.json) return printJson(r);
      console.log(`${c.green("published")} to ${values.branch}`);
      if (r.output) console.log(c.dim(r.output));
      return 0;
    }
    case "preview": {
      const r = await api<{ url: string; started: boolean }>("GET", `${base}/preview`);
      if (values.json) return printJson(r);
      console.log(`${c.bold(r.url)}${r.started ? "" : c.dim("   (already running)")}`);
      console.log(qrText(r.url));
      console.log(c.dim("Scan with Expo Go on the phone."));
      return 0;
    }
    default:
      console.error(USAGE);
      return 1;
  }
}
