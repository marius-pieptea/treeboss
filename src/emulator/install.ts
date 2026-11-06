/**
 * Installs the Android emulator from Google's own archives, with no Java and no sdkmanager. The disk is the
 * source of truth: every step derives what is left to do from what is there, so a crash, a cancel or a second
 * run converges to the same end state.
 *
 *   download  -> tmp/<sha1>.part, checked for size and sha1, then renamed to tmp/<sha1>.zip
 *   extract   -> tmp/<sha1>.x, with package.xml and the .trb-sha1 stamp added, then renamed onto destDir
 *   avd       -> avd/trb.ini and avd/trb.avd/config.ini, each written to a temp name and renamed
 *
 * The stamp is written inside the staged folder before the rename, so a destDir that has one is complete.
 * Only the owned folders (deps.paths) are ever written or deleted; an existing SDK is read, never touched.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Deps } from "./deps";
import { HostSeams, abiOf, findExistingSdk, probeHost, realSeams, sdkBins } from "./host";
import { MANIFEST_URLS, avdSpecFor, parseRepo, planInstall } from "./manifest";
import { unzip } from "./unzip";
import type { AvdSpec, HostProbe, InstallPlan, InstallStep, Installer, License, PackageArchive, SdkState } from "./types";

export const STAMP = ".trb-sha1";

/** A downloaded archive did not match Google's size or sha1. The owner reports it as failed, retryable. */
export class ChecksumError extends Error {}

/** Starts alphanumeric, so "." and ".." are out: the id becomes a file name under the SDK's licenses folder. */
const LICENSE_ID = /^[a-zA-Z0-9][\w.-]*$/;

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Windows virus scanners briefly hold freshly written folders, so a rename can fail with EPERM or EBUSY. */
async function rename(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

const rm = (p: string) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
const readStamp = (dir: string): string | null => {
  try {
    return fs.readFileSync(path.join(dir, STAMP), "utf-8").trim();
  } catch {
    return null;
  }
};

function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    fs.createReadStream(file).on("data", (d) => hash.update(d)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The AVD files, as text. `image.sysdir.1` is relative to the SDK root, which the emulator learns from
 * ANDROID_SDK_ROOT. swiftshader_indirect renders in software, which is what a headless emulator can rely on.
 */
export function renderAvd(spec: AvdSpec, avdHome: string): { ini: string; config: string } {
  const dir = path.join(avdHome, `${spec.name}.avd`);
  const ini = [`avd.ini.encoding=UTF-8`, `path=${dir}`, `target=android-${spec.api}`, ``].join("\n");
  const config = [
    `AvdId=${spec.name}`,
    `PlayStore.enabled=false`,
    `abi.type=${spec.abi}`,
    `avd.ini.displayname=${spec.name}`,
    `avd.ini.encoding=UTF-8`,
    `disk.dataPartition.size=${spec.dataMb}M`,
    `hw.accelerometer=yes`,
    `hw.audioInput=no`,
    `hw.audioOutput=no`,
    `hw.battery=yes`,
    `hw.camera.back=none`,
    `hw.camera.front=none`,
    `hw.cpu.arch=${spec.abi === "arm64-v8a" ? "arm64" : "x86_64"}`,
    `hw.cpu.ncore=4`,
    `hw.dPad=no`,
    `hw.gps=yes`,
    `hw.gpu.enabled=yes`,
    `hw.gpu.mode=swiftshader_indirect`,
    `hw.initialOrientation=portrait`,
    `hw.keyboard=yes`,
    `hw.lcd.density=${spec.dpi}`,
    `hw.lcd.height=${spec.height}`,
    `hw.lcd.width=${spec.width}`,
    `hw.mainKeys=no`,
    `hw.ramSize=${spec.ramMb}`,
    `hw.sdCard=no`,
    `hw.sensors.orientation=yes`,
    `hw.trackBall=no`,
    `image.sysdir.1=system-images/android-${spec.api}/google_apis/${spec.abi}/`,
    `runtime.network.latency=none`,
    `runtime.network.speed=full`,
    `showDeviceFrame=no`,
    `tag.display=Google APIs`,
    `tag.id=google_apis`,
    `vm.heapSize=256`,
    ``,
  ].join("\n");
  return { ini, config };
}

/** The package.xml sdkmanager and Android Studio read to recognise an installed package. */
export function renderPackageXml(pkg: PackageArchive, license: License | undefined): string {
  const [major = "0", minor = "0", micro = "0"] = pkg.revision.split(".");
  const image = /^system-images;android-(\d+);google_apis;(.+)$/.exec(pkg.path);
  const name = image ? `Google APIs ${image[2]} System Image` : pkg.path === "emulator" ? "Android Emulator" : "Android SDK Platform-Tools";
  const details = image
    ? `<type-details xsi:type="sys-img:sysImgDetailsType"><api-level>${image[1]}</api-level><base-extension>true</base-extension><tag><id>google_apis</id><display>Google APIs</display></tag><vendor><id>google</id><display>Google Inc.</display></vendor><abi>${image[2]}</abi></type-details>`
    : `<type-details xsi:type="generic:genericDetailsType"/>`;
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<common:repository xmlns:common="http://schemas.android.com/repository/android/common/02" xmlns:generic="http://schemas.android.com/repository/android/generic/02" xmlns:sys-img="http://schemas.android.com/sdk/android/repo/sys-img2/03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    license ? `<license id="${xml(license.id)}" type="text">${xml(license.text)}</license>` : ``,
    `<localPackage path="${xml(pkg.path)}" obsolete="false">${details}<revision><major>${major}</major><minor>${minor}</minor><micro>${micro}</micro></revision><display-name>${xml(name)}</display-name><uses-license ref="${xml(pkg.licenseId)}"/></localPackage>`,
    `</common:repository>`,
    ``,
  ].join("\n");
}

/** Archives hold one top-level folder named after the package (platform-tools/, emulator/, x86_64/); its contents are what goes in destDir. */
function contentRoot(stage: string): string {
  const entries = fs.readdirSync(stage, { withFileTypes: true });
  return entries.length === 1 && entries[0]!.isDirectory() ? path.join(stage, entries[0]!.name) : stage;
}

type OnStep = (step: InstallStep, doneBytes: number, totalBytes: number) => void;

async function installPackage(pkg: PackageArchive, plan: InstallPlan, deps: Deps, emit: (step: InstallStep, extra: number) => void, signal: AbortSignal): Promise<void> {
  const dest = path.join(plan.root, pkg.destDir);
  const part = path.join(deps.paths.tmp, `${pkg.sha1}.part`);
  const zip = path.join(deps.paths.tmp, `${pkg.sha1}.zip`);
  const stage = path.join(deps.paths.tmp, `${pkg.sha1}.x`);

  // The .zip name is only given after the size and sha1 check, but the file may have been changed or damaged since, so it is checked again.
  let haveZip = fs.existsSync(zip) && fs.statSync(zip).size === pkg.size;
  if (haveZip) {
    emit({ pkg: pkg.path, phase: "verify" }, pkg.size);
    haveZip = (await sha1File(zip)) === pkg.sha1;
  }
  if (!haveZip) {
    rm(zip);
    emit({ pkg: pkg.path, phase: "download" }, 0);
    fs.mkdirSync(deps.paths.tmp, { recursive: true });
    await deps.fetch.download(pkg.url, part, (bytes) => {
      signal.throwIfAborted();
      emit({ pkg: pkg.path, phase: "download" }, bytes);
    });
    emit({ pkg: pkg.path, phase: "verify" }, pkg.size);
    const size = fs.statSync(part).size;
    const sha1 = size === pkg.size ? await sha1File(part) : "";
    if (size !== pkg.size || sha1 !== pkg.sha1) {
      rm(part);
      throw new ChecksumError(`${pkg.path}: the download did not match Google's checksum (${size} bytes, sha1 ${sha1 || "not computed"}; expected ${pkg.size}, ${pkg.sha1}).`);
    }
    await rename(part, zip);
  }

  signal.throwIfAborted();
  emit({ pkg: pkg.path, phase: "extract" }, pkg.size);
  rm(stage);
  fs.mkdirSync(stage, { recursive: true });
  await unzip(zip, stage, signal);
  const content = contentRoot(stage);
  fs.writeFileSync(path.join(content, "package.xml"), renderPackageXml(pkg, plan.licenses.find((l) => l.id === pkg.licenseId)));
  fs.writeFileSync(path.join(content, STAMP), `${pkg.sha1}\n`);
  rm(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await rename(content, dest);
  rm(stage);
  rm(zip);
}

/** Idempotent. Packages already stamped are skipped, a verified archive from an interrupted run is reused, and the AVD is rewritten from its spec. */
export async function runInstall(plan: InstallPlan, deps: Deps, onStep: OnStep, signal: AbortSignal): Promise<void> {
  if (plan.packages.length && path.resolve(plan.root) !== path.resolve(deps.paths.root)) throw new Error("Refusing to install into an SDK treeboss does not own.");
  const total = plan.packages.reduce((sum, p) => sum + p.size, 0);
  let done = 0;
  for (const pkg of plan.packages) {
    signal.throwIfAborted();
    if (readStamp(path.join(plan.root, pkg.destDir)) === pkg.sha1) {
      done += pkg.size;
      continue;
    }
    await installPackage(pkg, plan, deps, (step, extra) => onStep(step, done + extra, total), signal);
    done += pkg.size;
  }
  signal.throwIfAborted();
  onStep({ pkg: "avd", phase: "create" }, done, total);
  const { ini, config } = renderAvd(plan.avd, plan.avdHome);
  writeAtomic(path.join(plan.avdHome, `${plan.avd.name}.avd`, "config.ini"), config);
  writeAtomic(path.join(plan.avdHome, `${plan.avd.name}.ini`), ini);
}

/** What the disk says, without fetching. A root whose packages lack a stamp reads as absent: the next run resumes it. */
export function reconcileSdk(deps: Deps, s: HostSeams): SdkState {
  const abi = abiOf(s.arch);
  const avd = avdSpecFor(abi);
  const avdThere = s.exists(path.join(deps.paths.avdHome, `${avd.name}.ini`)) && s.exists(path.join(deps.paths.avdHome, `${avd.name}.avd`, "config.ini"));
  if (!avdThere) return { kind: "absent" };
  const stamped = ["platform-tools", "emulator", avd.image.split(";").join("/")].every((dir) => s.exists(path.join(deps.paths.root, dir, STAMP)));
  if (stamped) return { kind: "installed", root: deps.paths.root, owned: true, avd };
  const existing = findExistingSdk(s.env, s.os, s.exists, abi);
  return existing ? { kind: "installed", root: existing, owned: false, avd } : { kind: "absent" };
}

/** Deletes treeboss's own folders and nothing else; a root from findExistingSdk is never a parameter here. Safe to repeat. */
export async function removeOwned(deps: Deps): Promise<void> {
  for (const dir of [deps.paths.avdHome, deps.paths.root, deps.paths.tmp]) rm(dir);
}

export function createInstaller(deps: Deps, seams: Partial<HostSeams> = {}): Installer {
  const host = (): HostSeams => ({ ...realSeams(), ...seams });
  return {
    probe: () => probeHost(deps, seams),
    reconcile: async () => reconcileSdk(deps, host()),
    async plan(probe: HostProbe) {
      // A usable SDK of the operator's is used read-only: nothing to download, only our own AVD to create.
      if (probe.existingSdk) return { root: probe.existingSdk, avdHome: deps.paths.avdHome, packages: [], licenses: [], avd: avdSpecFor(probe.abi) };
      const [repo, sysimg] = await Promise.all([deps.fetch.text(MANIFEST_URLS.repo), deps.fetch.text(MANIFEST_URLS.sysimg)]);
      return planInstall(parseRepo(repo, MANIFEST_URLS.repo), parseRepo(sysimg, MANIFEST_URLS.sysimg), probe, deps.paths);
    },
    async accept(plan, licenseIds) {
      const picked = licenseIds.map((id) => {
        const license = plan.licenses.find((l) => l.id === id);
        if (!license || !LICENSE_ID.test(id)) throw new Error(`"${id}" is not a license in this plan.`);
        return license;
      });
      if (picked.length && path.resolve(plan.root) !== path.resolve(deps.paths.root)) throw new Error("Refusing to record licenses in an SDK treeboss does not own.");
      for (const l of picked) writeAtomic(path.join(plan.root, "licenses", l.id), `${l.hash}\n`);
    },
    run: (plan, onStep, signal) => runInstall(plan, deps, onStep, signal),
    remove: () => removeOwned(deps),
    bin: (root) => sdkBins(root, host().os),
  };
}
