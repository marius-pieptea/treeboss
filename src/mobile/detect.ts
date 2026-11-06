/**
 * Whether a directory is an Expo app, and what it targets: platforms, bundle id, Android package, build
 * profiles. Pure reads of app.json, app.config.* and eas.json. app.config.* files are never executed (they
 * are JavaScript); their identifiers are read with a pattern, and the result says so.
 */
import fs from "fs";
import path from "path";

export type MobilePlatform = "ios" | "android";

export interface MobileProject {
  isExpo: boolean;
  name: string | null;
  slug: string | null;
  /** The `expo` dependency's range from package.json, e.g. "~54.0.0". */
  sdkVersion: string | null;
  /** Which app config the identifiers came from, if any. */
  configFile: "app.json" | "app.config.js" | "app.config.ts" | "app.config.cjs" | "app.config.mjs" | null;
  easFile: boolean;
  /** Keys of eas.json's `build` object. */
  profiles: string[];
  /** Keys of eas.json's `submit` object. */
  submitProfiles: string[];
  platforms: MobilePlatform[];
  bundleId: string | null;
  androidPackage: string | null;
  /** What the reader could not settle, e.g. a dynamic app.config.ts. Shown to the operator, never hidden. */
  notes: string[];
}

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
};

const readJson = (file: string): any => {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isObject = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const CONFIG_FILES = ["app.config.ts", "app.config.js", "app.config.cjs", "app.config.mjs"] as const;

/** Reads the identifiers out of a dynamic config without running it. */
function scanConfig(text: string): { bundleId: string | null; androidPackage: string | null } {
  const grab = (key: string) => new RegExp(`${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(text)?.[1]?.trim() || null;
  return { bundleId: grab("bundleIdentifier"), androidPackage: grab("package") };
}

export function detectMobile(dir: string): MobileProject {
  const notes: string[] = [];
  const pkg = readJson(path.join(dir, "package.json"));
  const deps: Record<string, string> = isObject(pkg) ? { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } : {};
  const sdkVersion = str(deps.expo);

  let name: string | null = null;
  let slug: string | null = null;
  let bundleId: string | null = null;
  let androidPackage: string | null = null;
  let platforms: MobilePlatform[] = [];
  let configFile: MobileProject["configFile"] = null;
  let appJsonHasExpo = false;

  const appJson = readJson(path.join(dir, "app.json"));
  if (appJson === undefined) notes.push("app.json is not valid JSON.");
  else if (isObject(appJson)) {
    const expo = isObject(appJson.expo) ? appJson.expo : null;
    appJsonHasExpo = expo !== null;
    const cfg = expo ?? appJson;
    configFile = "app.json";
    name = str(cfg.name);
    slug = str(cfg.slug);
    if (Array.isArray(cfg.platforms)) platforms = cfg.platforms.filter((p: unknown): p is MobilePlatform => p === "ios" || p === "android");
    bundleId = str(cfg.ios?.bundleIdentifier);
    androidPackage = str(cfg.android?.package);
  }

  // A dynamic config wins over app.json in Expo, so it is the one that decides when present.
  const dynamic = CONFIG_FILES.find((f) => fs.existsSync(path.join(dir, f)));
  if (dynamic) {
    configFile = dynamic as MobileProject["configFile"];
    const text = readText(path.join(dir, dynamic)) ?? "";
    const found = scanConfig(text);
    if (found.bundleId || found.androidPackage) {
      bundleId = found.bundleId ?? bundleId;
      androidPackage = found.androidPackage ?? androidPackage;
      notes.push(`${dynamic} is read as text, not run: identifiers that are computed in it are not seen.`);
    } else {
      notes.push(`${dynamic} is read as text, not run, and no bundle id or package was found in it.`);
    }
  }

  const eas = readJson(path.join(dir, "eas.json"));
  const easFile = eas !== null && eas !== undefined;
  if (eas === undefined) notes.push("eas.json is not valid JSON.");
  const profiles = isObject(eas?.build) ? Object.keys(eas.build) : [];
  const submitProfiles = isObject(eas?.submit) ? Object.keys(eas.submit) : [];

  const isExpo = sdkVersion !== null || appJsonHasExpo || dynamic !== undefined || easFile;
  if (!platforms.length && isExpo) platforms = ["ios", "android"];
  if (!isExpo) platforms = [];

  return { isExpo, name, slug, sdkVersion, configFile, easFile, profiles, submitProfiles, platforms, bundleId, androidPackage, notes };
}
