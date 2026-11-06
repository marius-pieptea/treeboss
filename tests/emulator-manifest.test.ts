/** The manifest parser and install planner, against trimmed copies of Google's real package lists. */
import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { MANIFEST_URLS, licenseHash, parseRepo, planInstall } from "../src/emulator/manifest";

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dir, "fixtures", "emulator", name), "utf-8");
const repo = parseRepo(fixture("repository2-4.xml"), MANIFEST_URLS.repo);
const sysimg = parseRepo(fixture("sys-img2-5.xml"), MANIFEST_URLS.sysimg);
const where = { root: "/sdk", avdHome: "/avd" };

describe("parseRepo", () => {
  test("reads packages, channels, archives and licenses", () => {
    const emulators = repo.packages.filter((p) => p.path === "emulator");
    expect(emulators.map((p) => p.channel).sort()).toEqual(["channel-0", "channel-2"]);
    expect(repo.packages.some((p) => p.path.startsWith("emulators;"))).toBe(true);
    const tools = repo.packages.find((p) => p.path === "platform-tools")!;
    expect(tools.archives).toHaveLength(3);
    expect(tools.archives.find((a) => a.hostOs === "windows")).toMatchObject({ url: "platform-tools_r37.0.1-win.zip", size: 8044989, hostArch: null });
    expect(Object.keys(repo.licenses).sort()).toEqual(["android-sdk-license", "android-sdk-preview-license"]);
    expect(repo.licenses["android-sdk-license"]).toContain("Android Software Development Kit License Agreement");
  });
});

describe("planInstall", () => {
  test("windows/x64 picks the stable emulator, platform-tools and the android-35 x86_64 image", () => {
    const plan = planInstall(repo, sysimg, { os: "windows", arch: "x64", abi: "x86_64" }, where);
    expect(plan.packages.map((p) => p.path)).toEqual(["platform-tools", "emulator", "system-images;android-35;google_apis;x86_64"]);
    const [tools, emulator, image] = plan.packages;
    expect(emulator).toMatchObject({ revision: "37.2.13", sha1: "4d7268aa7787c640ad892844e6c9a5f159e91ad3", licenseId: "android-sdk-license", destDir: "emulator" });
    expect(emulator!.url).toBe("https://dl.google.com/android/repository/emulator-windows_x64-16740729.zip");
    expect(tools).toMatchObject({ revision: "37.0.1", size: 8044989, destDir: "platform-tools" });
    expect(tools!.url).toBe("https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip");
    expect(image).toMatchObject({ revision: "9.0.0", size: 1738815903, destDir: "system-images/android-35/google_apis/x86_64" });
    expect(image!.url).toBe("https://dl.google.com/android/repository/sys-img/google_apis/x86_64-35_r09.zip");
    expect(plan.root).toBe("/sdk");
    expect(plan.avd).toMatchObject({ name: "trb", abi: "x86_64", api: 35, width: 720, height: 1600, dpi: 320 });
  });

  test("the preview emulators and the channel-2 emulator are never picked", () => {
    for (const host of [{ os: "windows", arch: "x64", abi: "x86_64" }, { os: "linux", arch: "x64", abi: "x86_64" }] as const) {
      const emulator = planInstall(repo, sysimg, host, where).packages.find((p) => p.path === "emulator")!;
      expect(emulator.url).not.toContain("16696583");
      expect(emulator.url).toContain("16740729");
    }
  });

  test("macosx/aarch64 picks the arm64-v8a image and the aarch64 emulator", () => {
    const plan = planInstall(repo, sysimg, { os: "macosx", arch: "aarch64", abi: "arm64-v8a" }, where);
    expect(plan.packages.find((p) => p.path === "emulator")!.url).toContain("darwin_aarch64");
    expect(plan.packages[2]).toMatchObject({ path: "system-images;android-35;google_apis;arm64-v8a", destDir: "system-images/android-35/google_apis/arm64-v8a" });
  });

  test("licenses are the union the plan references, each with its text and hash", () => {
    const x64 = planInstall(repo, sysimg, { os: "windows", arch: "x64", abi: "x86_64" }, where);
    expect(x64.licenses.map((l) => l.id)).toEqual(["android-sdk-license"]);
    const arm = planInstall(repo, sysimg, { os: "macosx", arch: "aarch64", abi: "arm64-v8a" }, where);
    expect(arm.licenses.map((l) => l.id)).toEqual(["android-sdk-license", "android-sdk-arm-dbt-license"]);
    for (const l of arm.licenses) {
      expect(l.text.length).toBeGreaterThan(200);
      expect(l.hash).toBe(licenseHash(l.text));
    }
  });

  test("a host Google has no build for is an error, not a wrong download", () => {
    expect(() => planInstall(repo, sysimg, { os: "windows", arch: "aarch64", abi: "arm64-v8a" }, where)).toThrow("windows/aarch64");
  });
});

test("licenseHash is a 40-hex sha1 of the trimmed text", () => {
  expect(licenseHash("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  expect(licenseHash("  abc\n")).toBe(licenseHash("abc"));
});

describe("archive urls", () => {
  const winTools = "platform-tools_r37.0.1-win.zip";
  const planWith = (url: string) => {
    const xml = fixture("repository2-4.xml").replace(`<url>${winTools}</url>`, `<url>${url}</url>`);
    return planInstall(parseRepo(xml, MANIFEST_URLS.repo), sysimg, { os: "windows", arch: "x64", abi: "x86_64" }, where);
  };

  test("an absolute https url on dl.google.com is accepted", () => {
    expect(planWith("https://dl.google.com/android/repository/other.zip").packages[0]!.url).toBe("https://dl.google.com/android/repository/other.zip");
  });

  for (const url of [
    "https://evil.example/a.zip",
    "http://dl.google.com/android/repository/a.zip",
    "file:///C:/Windows/win.ini",
    "https://dl.google.com.evil.example/a.zip",
    "https://evil.example/dl.google.com/a.zip",
    "https://dl.google.com@evil.example/a.zip",
    "https://user:pw@dl.google.com/a.zip",
    "https://dl.google.com:8443/a.zip",
    "//evil.example/a.zip",
  ]) {
    test(`refuses ${url}`, () => {
      expect(() => planWith(url)).toThrow("dl.google.com");
    });
  }
});
