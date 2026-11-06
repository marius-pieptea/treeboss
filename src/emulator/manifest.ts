/**
 * Google's package lists (the SDK "repository" manifests) turned into an install plan. Pure: XML text in, plan
 * out, so it is tested against trimmed copies of the real manifests and never touches the network.
 *
 * The parser is deliberately small and scoped to the <license> and <remotePackage> blocks: the repo has no
 * XML dependency, and nothing else in the manifests matters here. No XML type leaves this file.
 */
import crypto from "crypto";
import type { Abi, AvdSpec, HostArch, HostOs, HostProbe, InstallPlan, License, PackageArchive, SdkPath } from "./types";

const BASE = "https://dl.google.com/android/repository/";
/** Where each manifest lives. Archive URLs inside are relative to the manifest's own folder. */
export const MANIFEST_URLS = {
  repo: `${BASE}repository2-4.xml`,
  sysimg: `${BASE}sys-img/google_apis/sys-img2-5.xml`,
} as const;
/** The only Android version treeboss installs: Expo's current target, and Google ships it for both ABIs. */
export const IMAGE_API = 35;

export interface Revision {
  major: number;
  minor: number;
  micro: number;
}
export interface RemoteArchive {
  url: string;
  sha1: string;
  size: number;
  hostOs: HostOs | null; // null: any
  hostArch: HostArch | null;
}
export interface RemotePackage {
  path: string;
  revision: Revision;
  channel: string;
  licenseId: string;
  archives: RemoteArchive[];
}
export interface RemoteIndex {
  /** The manifest's own URL: its archive URLs resolve against it. */
  baseUrl: string;
  licenses: Record<string, string>;
  packages: RemotePackage[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1]!.trim() : null;
};
const attr = (xml: string, name: string, attrName: string): string | null => {
  const m = new RegExp(`<${name}\\s[^>]*?\\b${attrName}="([^"]*)"`).exec(xml);
  return m ? decode(m[1]!) : null;
};

function parseArchive(xml: string): RemoteArchive | null {
  const complete = tag(xml, "complete");
  if (!complete) return null;
  const url = tag(complete, "url");
  const sha1 = tag(complete, "checksum");
  const size = Number(tag(complete, "size"));
  if (!url || !sha1 || !Number.isFinite(size)) return null;
  const os = tag(xml, "host-os");
  const arch = tag(xml, "host-arch");
  return { url, sha1: sha1.toLowerCase(), size, hostOs: os as HostOs | null, hostArch: arch as HostArch | null };
}

/** `manifestUrl` is where the XML came from: archive URLs are relative to its folder. */
export function parseRepo(xml: string, manifestUrl: string = MANIFEST_URLS.repo): RemoteIndex {
  const licenses: Record<string, string> = {};
  for (const m of xml.matchAll(/<license\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/license>/g)) licenses[m[1]!] = decode(m[2]!);
  const packages: RemotePackage[] = [];
  for (const m of xml.matchAll(/<remotePackage\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/remotePackage>/g)) {
    const body = m[2]!;
    const rev = tag(body, "revision");
    const licenseId = attr(body, "uses-license", "ref");
    if (!rev || !licenseId) continue;
    const num = (n: string) => Number(tag(rev, n) ?? 0);
    const archives = [...body.matchAll(/<archive>([\s\S]*?)<\/archive>/g)].map((a) => parseArchive(a[1]!)).filter((a): a is RemoteArchive => a !== null);
    packages.push({ path: decode(m[1]!), revision: { major: num("major"), minor: num("minor"), micro: num("micro") }, channel: attr(body, "channelRef", "ref") ?? "", licenseId, archives });
  }
  return { baseUrl: manifestUrl, licenses, packages };
}

const revString = (r: Revision) => `${r.major}.${r.minor}.${r.micro}`;
const newer = (a: Revision, b: Revision) => a.major - b.major || a.minor - b.minor || a.micro - b.micro;

/** The newest stable (channel-0) package at this exact path. `emulators;<build>` previews have other paths, so they never match. */
function stable(index: RemoteIndex, path: string): RemotePackage {
  const found = index.packages.filter((p) => p.path === path && p.channel === "channel-0").sort((a, b) => newer(b.revision, a.revision))[0];
  if (!found) throw new Error(`Google's package list has no stable "${path}".`);
  return found;
}

function archiveFor(pkg: RemotePackage, host: Pick<HostProbe, "os" | "arch">): RemoteArchive {
  const a = pkg.archives.find((x) => (x.hostOs === null || x.hostOs === host.os) && (x.hostArch === null || x.hostArch === host.arch));
  if (!a) throw new Error(`Google ships no "${pkg.path}" for ${host.os}/${host.arch}.`);
  return a;
}

/** Archives are only ever fetched from Google's own host, so a tampered manifest cannot point the download anywhere else (Bun's fetch reads file: URLs). */
function archiveUrl(raw: string, base: string): string {
  const url = new URL(raw, base);
  if (url.protocol !== "https:" || url.hostname !== "dl.google.com" || url.port !== "" || url.username !== "" || url.password !== "") {
    throw new Error(`Google's package list points at ${raw}, which is not an https URL on dl.google.com.`);
  }
  return url.href;
}

const destOf = (p: SdkPath) => p.split(";").join("/");

export function licenseHash(text: string): string {
  return crypto.createHash("sha1").update(text.trim()).digest("hex");
}

/** The one virtual device treeboss creates: a 720x1600 phone at 320 dpi keeps each PNG frame small. */
export function avdSpecFor(abi: Abi): AvdSpec {
  return { name: "trb", image: `system-images;android-${IMAGE_API};google_apis;${abi}`, abi, api: IMAGE_API, width: 720, height: 1600, dpi: 320, ramMb: 2048, dataMb: 6144 };
}

export function planInstall(repo: RemoteIndex, sysimg: RemoteIndex, host: Pick<HostProbe, "os" | "arch" | "abi">, paths: { root: string; avdHome: string }): InstallPlan {
  const avd = avdSpecFor(host.abi);
  const image = avd.image;
  const picks: [RemotePackage, RemoteIndex, SdkPath][] = [
    [stable(repo, "platform-tools"), repo, "platform-tools"],
    [stable(repo, "emulator"), repo, "emulator"],
    [stable(sysimg, image), sysimg, image],
  ];
  const packages: PackageArchive[] = picks.map(([pkg, index, path]) => {
    const a = archiveFor(pkg, host);
    return { path, revision: revString(pkg.revision), url: archiveUrl(a.url, index.baseUrl), sha1: a.sha1, size: a.size, licenseId: pkg.licenseId, destDir: destOf(path) };
  });
  const texts = { ...repo.licenses, ...sysimg.licenses };
  const licenses: License[] = [...new Set(packages.map((p) => p.licenseId))].map((id) => {
    const text = texts[id];
    if (text === undefined) throw new Error(`Google's package list names the license "${id}" but does not include its text.`);
    return { id, text, hash: licenseHash(text) };
  });
  return { root: paths.root, avdHome: paths.avdHome, packages, licenses, avd };
}
