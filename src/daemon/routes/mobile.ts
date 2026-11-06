/**
 * The mobile pipeline (Expo and EAS) over HTTP. `:root` is a root reference (w_… or s_…), like the roadmap.
 *
 *   GET  /api/mobile/:root            detect (Expo, platforms, bundle id, profiles), store metadata check, recent builds and submissions
 *   GET  /api/mobile/:root/builds     recent builds
 *   POST /api/mobile/:root/builds     { platform: ios|android|all, profile } queue cloud builds (returns at once)
 *   POST /api/mobile/:root/submit     { platform: ios|android, profile } submit the latest finished build (TestFlight / Play internal)
 *   POST /api/mobile/:root/update     { branch, message } publish an over-the-air update
 *   GET  /api/mobile/:root/preview    { url, svg, started } the Expo Go tunnel URL and its QR code
 *
 * Cloud calls need EXPO_TOKEN from the workspace's secrets; without it they answer 400 with what to add.
 */
import { resolveRoot } from "../../workspaces";
import { detectMobile, type MobilePlatform } from "../../mobile/detect";
import { expoGoUrl } from "../../mobile/preview";
import { checkPlatform, MobileError, publishUpdate, startBuild, submitLatest } from "../../mobile/eas";
import { inFlightBuilds, listBuilds, listSubmissions, readStoreMetadata, recordBuilds, recordSubmission } from "../../mobile/store";
import { json, type Ctx, type RouteModule } from "../http";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export const mobileRoutes: RouteModule = async (c: Ctx) => {
  const m = c.match(/^\/api\/mobile\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const root = resolveRoot(m[1]!);
  const dir = root.dir;
  const ws = root.ref;
  const rest = m[2] ?? "";
  const b = c.body;

  if (rest === "" && c.method === "GET") {
    return json({
      detect: detectMobile(dir),
      metadata: readStoreMetadata(dir),
      builds: listBuilds(ws, 20),
      submissions: listSubmissions(ws, 10),
    });
  }

  if (rest === "builds" && c.method === "GET") return json({ builds: listBuilds(ws, 50), inFlight: inFlightBuilds().filter((x) => x.workspaceId === ws).length });

  if (rest === "builds" && c.method === "POST") {
    const platform = checkPlatform(str(b.platform) || "all", true);
    const profile = str(b.profile) || "production";
    const builds = await startBuild(dir, { platform, profile }, { workspaceId: ws });
    return json({ builds: recordBuilds(ws, { platform, profile }, builds) }, 201);
  }

  if (rest === "submit" && c.method === "POST") {
    const platform = checkPlatform(str(b.platform), false) as MobilePlatform;
    const profile = str(b.profile);
    if (!profile) throw new MobileError("Name the submit profile to use, as it is in eas.json.");
    const latest = listBuilds(ws, 50).find((x) => x.platform === platform && x.status === "finished");
    try {
      const output = await submitLatest(dir, { platform, profile }, { workspaceId: ws });
      return json({ submission: recordSubmission(ws, { platform, profile, buildId: latest?.id ?? null, status: "submitted", detail: output }) }, 201);
    } catch (e) {
      recordSubmission(ws, { platform, profile, buildId: latest?.id ?? null, status: "failed", detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  if (rest === "update" && c.method === "POST") {
    const branch = str(b.branch);
    const message = str(b.message);
    if (!branch) throw new MobileError("Name the branch to publish to.");
    const output = await publishUpdate(dir, { branch, message }, { workspaceId: ws });
    return json({ branch, message, output });
  }

  if (rest === "preview" && c.method === "GET") return json(await expoGoUrl(dir));

  return null;
};
