import { describe, expect, test } from "bun:test";
import {
  countResults,
  countTree,
  currentLabel,
  currentPercent,
  filterSkills,
  formatBytes,
  formatElapsed,
  formatEta,
  formatReport,
  initialSelection,
  isEntryFile,
  isMultiFile,
  isStalled,
  joinPath,
  looksLikeSkillsFolder,
  matchesSkill,
  monotonic,
  overallPercent,
  packActions,
  packCountText,
  packSections,
  parentOf,
  plural,
  pulseChanged,
  pulseOf,
  reconcileSelection,
  safeHttpUrl,
  scanSummary,
  selectable,
  selectedSummary,
  selectionState,
  setAll,
  skillFlags,
  sortEntries,
  summarizeResults,
  unpackedSkills,
  validateEntryPath,
  type FsEntry,
  type ImportItem,
  type ImportJobState,
  type PackableSkill,
  type ScanResult,
  type ScanSkill,
  type SkillPack,
} from "../../web/src/features/settings/skills-logic";

const skill = (name: string, over: Partial<ScanSkill> = {}): ScanSkill => ({ name, description: `${name} does things`, relDir: name, dir: `/x/${name}`, files: 1, bytes: 100, exists: false, notes: [], ...over });
const job = (over: Partial<ImportJobState> = {}): ImportJobState => ({ id: "j", status: "running", root: "/x", total: 4, done: 0, totalBytes: 0, doneBytes: 0, current: null, results: [], startedAt: "", finishedAt: null, ...over });

describe("sizes and times", () => {
  test("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });
  test("plural", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(2, "skill")).toBe("2 skills");
  });
  test("formatElapsed", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_900)).toBe("0:07");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatElapsed(-5)).toBe("0:00");
  });
  test("formatEta stays quiet until it can be honest", () => {
    expect(formatEta(1000, 50)).toBeNull();
    expect(formatEta(10_000, 2)).toBeNull();
    expect(formatEta(10_000, 100)).toBeNull();
    expect(formatEta(10_000, 50)).toBe("about 10s left");
    expect(formatEta(10_000, 95)).toBe("a few seconds left");
    expect(formatEta(60_000, 10)).toBe("about 9 min left");
  });
});

describe("the scan checklist", () => {
  const skills = [skill("a"), skill("b", { exists: true }), skill("c", { error: "too big" }), skill("d", { exists: true, error: "too big" })];

  test("selectable", () => {
    expect(selectable(skills[0], false)).toBe(true);
    expect(selectable(skills[1], false)).toBe(false);
    expect(selectable(skills[1], true)).toBe(true);
    expect(selectable(skills[2], true)).toBe(false);
    expect(selectable(skills[3], true)).toBe(false);
  });
  test("initialSelection ticks what can be imported", () => {
    expect([...initialSelection(skills, false)]).toEqual(["a"]);
    expect([...initialSelection(skills, true)].sort()).toEqual(["a", "b"]);
  });
  test("reconcile: overwrite on ticks existing ones, off unticks them, hand choices stay", () => {
    const on = reconcileSelection(new Set(["a"]), skills, true);
    expect([...on].sort()).toEqual(["a", "b"]);
    const off = reconcileSelection(on, skills, false);
    expect([...off]).toEqual(["a"]);
    const manual = reconcileSelection(new Set<string>(), [skill("a"), skill("z")], false);
    expect(manual.size).toBe(0);
  });
  test("filterSkills matches name, description and folder", () => {
    const list = [skill("alpha", { description: "Parses CSV", relDir: "data/alpha" }), skill("beta", { description: "Draws", relDir: "viz/beta" })];
    expect(filterSkills(list, "").length).toBe(2);
    expect(filterSkills(list, "ALP").map((s) => s.name)).toEqual(["alpha"]);
    expect(filterSkills(list, "csv").map((s) => s.name)).toEqual(["alpha"]);
    expect(filterSkills(list, "viz/").map((s) => s.name)).toEqual(["beta"]);
    expect(filterSkills(list, "nothing")).toEqual([]);
  });
  test("setAll acts on the filtered view only and skips what is not selectable", () => {
    const prev = new Set(["a"]);
    const added = setAll(prev, [skills[1], skills[2]], false, true);
    expect([...added]).toEqual(["a"]);
    const more = setAll(prev, [skill("e"), skill("f")], false, true);
    expect([...more].sort()).toEqual(["a", "e", "f"]);
    const cleared = setAll(more, [skill("e")], false, false);
    expect([...cleared].sort()).toEqual(["a", "f"]);
  });
  test("selectionState for the header checkbox", () => {
    const list = [skill("a"), skill("b")];
    expect(selectionState(new Set(), list, false)).toBe("none");
    expect(selectionState(new Set(["a"]), list, false)).toBe("some");
    expect(selectionState(new Set(["a", "b"]), list, false)).toBe("all");
    expect(selectionState(new Set(["a"]), [skill("c", { error: "x" })], false)).toBe("none");
  });
  test("summaries", () => {
    const scan: ScanResult = { root: "/x", skills: [skill("a", { files: 3, bytes: 2048 }), skill("b", { files: 1, bytes: 1024 })], duplicates: [], truncated: false };
    expect(scanSummary(scan)).toBe("Found 2 skills · 4 files · 3.0 KB");
    expect(scanSummary({ ...scan, skills: [] })).toBe("No skills found");
    expect(selectedSummary(scan, new Set(["a"]))).toEqual({ count: 1, files: 3, bytes: 2048 });
  });
  test("skillFlags", () => {
    expect(skillFlags(skill("a"))).toEqual([]);
    const f = skillFlags(skill("a", { exists: true, error: "too big", notes: ["node_modules left out", ".git left out"] }));
    expect(f.map((x) => x.kind)).toEqual(["fail", "exists", "notes"]);
    expect(f[2].label).toBe("2 left out");
    expect(f[2].title).toContain("node_modules");
  });
  test("looksLikeSkillsFolder", () => {
    expect(looksLikeSkillsFolder("skills")).toBe(true);
    expect(looksLikeSkillsFolder(".claude")).toBe(true);
    expect(looksLikeSkillsFolder("agent-skills")).toBe(true);
    expect(looksLikeSkillsFolder("Documents")).toBe(false);
  });
});

describe("progress", () => {
  test("currentPercent is how far through the skill in flight", () => {
    expect(currentPercent(job())).toBe(0);
    expect(currentPercent(job({ current: { name: "a", filesDone: 5, filesTotal: 20 } }))).toBe(25);
    expect(currentPercent(job({ current: { name: "a", filesDone: 0, filesTotal: 0 } }))).toBe(0);
    expect(currentPercent(job({ current: { name: "a", filesDone: 9, filesTotal: 3 } }))).toBe(100);
  });
  test("overallPercent weighs bytes, counts the partial skill, and never says 100 before done", () => {
    expect(overallPercent(job({ status: "done" }))).toBe(100);
    expect(overallPercent(job({ total: 0 }))).toBe(0);
    // 2 of 4 skills done by count, no bytes known
    expect(overallPercent(job({ total: 4, done: 2 }))).toBe(50);
    // by bytes: 100 of 1000 done, a 400-byte skill half copied
    expect(overallPercent(job({ totalBytes: 1000, doneBytes: 100, current: { name: "a", filesDone: 1, filesTotal: 2 } }), 400)).toBe(30);
    // one big skill is not one fourth of the work
    expect(overallPercent(job({ total: 4, done: 1, totalBytes: 1000, doneBytes: 900 }))).toBe(90);
    // everything copied but the daemon has not said done
    expect(overallPercent(job({ total: 2, done: 2 }))).toBe(99);
  });
  test("monotonic never goes backwards", () => {
    expect(monotonic(40, 30)).toBe(40);
    expect(monotonic(40, 55)).toBe(55);
  });
  test("pulse detects any movement", () => {
    const a = pulseOf(job({ done: 1, doneBytes: 10, current: { name: "a", filesDone: 2, filesTotal: 9 } }));
    expect(pulseChanged(null, a)).toBe(true);
    expect(pulseChanged(a, { ...a })).toBe(false);
    expect(pulseChanged(a, { ...a, filesDone: 3 })).toBe(true);
    expect(pulseChanged(a, { ...a, name: "b" })).toBe(true);
    expect(pulseChanged(a, { ...a, done: 2 })).toBe(true);
  });
  test("a bar only counts as stalled while running", () => {
    expect(isStalled("running", 1000, 3999)).toBe(false);
    expect(isStalled("running", 1000, 4000)).toBe(true);
    expect(isStalled("done", 0, 99999)).toBe(false);
    expect(isStalled("cancelled", 0, 99999)).toBe(false);
  });
  test("currentLabel", () => {
    expect(currentLabel(job())).toBeNull();
    expect(currentLabel(job({ current: { name: "pdf", filesDone: 3, filesTotal: 40 } }))).toBe("Copying pdf (3/40 files)");
    expect(currentLabel(job({ current: { name: "pdf", filesDone: 0, filesTotal: 1 } }))).toBe("Copying pdf (0/1 file)");
    expect(currentLabel(job({ current: { name: "pdf", filesDone: 0, filesTotal: 0 } }))).toBe("Copying pdf");
  });
});

describe("results", () => {
  const results: ImportItem[] = [
    { name: "a", status: "added", files: 3, bytes: 2048 },
    { name: "b", status: "replaced", files: 1, bytes: 10 },
    { name: "c", status: "skipped", files: 1, bytes: 1, reason: "already imported" },
    { name: "d", status: "failed", files: 0, bytes: 0, reason: "too big" },
  ];
  test("countResults and summarizeResults", () => {
    expect(countResults(results)).toEqual({ added: 1, replaced: 1, skipped: 1, failed: 1 });
    expect(summarizeResults(results)).toBe("Imported 2 (1 replaced), skipped 1, failed 1");
    expect(summarizeResults(results.slice(0, 1))).toBe("Imported 1, skipped 0, failed 0");
    expect(summarizeResults(results.slice(0, 1), true)).toBe("Imported 1, skipped 0, failed 0 (cancelled)");
  });
  test("formatReport lists each skill with its reason", () => {
    const text = formatReport({ root: "/x/skills", status: "done", results, total: 4, startedAt: "", finishedAt: "" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Skill import from /x/skills");
    expect(lines[1]).toBe("Imported 2 (1 replaced), skipped 1, failed 1 of 4");
    expect(text).toContain("added    a (3 files, 2.0 KB)");
    expect(text).toContain("failed   d (0 files, 0 B): too big");
  });
});

describe("files inside a skill", () => {
  const e = (name: string, type: "file" | "dir", size = 0): FsEntry => ({ name, path: name, type, size });
  test("sortEntries puts folders first and reads numbers as numbers", () => {
    const sorted = sortEntries([e("step10.md", "file"), e("SKILL.md", "file"), e("scripts", "dir"), e("step2.md", "file"), e("Assets", "dir")]);
    expect(sorted.map((x) => x.name)).toEqual(["Assets", "scripts", "SKILL.md", "step2.md", "step10.md"]);
  });
  test("paths", () => {
    expect(isEntryFile("SKILL.md")).toBe(true);
    expect(isEntryFile("docs/SKILL.md")).toBe(false);
    expect(parentOf("a/b/c.md")).toBe("a/b");
    expect(parentOf("c.md")).toBe("");
    expect(joinPath("", "c.md")).toBe("c.md");
    expect(joinPath("a", "c.md")).toBe("a/c.md");
  });
  test("validateEntryPath", () => {
    expect(validateEntryPath("")).toBe("A name is required.");
    expect(validateEntryPath("   ")).toBe("A name is required.");
    expect(validateEntryPath("/etc/passwd")).toMatch(/absolute/);
    expect(validateEntryPath("~/x")).toMatch(/absolute/);
    expect(validateEntryPath("a\\b")).toMatch(/forward/);
    expect(validateEntryPath("a//b")).toMatch(/empty parts/);
    expect(validateEntryPath("a/")).toMatch(/empty parts/);
    expect(validateEntryPath("../x")).toMatch(/\.\./);
    expect(validateEntryPath("a/./b")).toMatch(/\.\./);
    expect(validateEntryPath(".git/config")).toMatch(/\.git/);
    expect(validateEntryPath("refs/a.md")).toBeNull();
    expect(validateEntryPath("refs/a.md", ["refs/a.md"])).toMatch(/already exists/);
    // renaming a file to its own name is not a collision
    expect(validateEntryPath("refs/a.md", ["refs/a.md"], "refs/a.md")).toBeNull();
  });
  test("countTree", () => {
    const listing = new Map<string, FsEntry[]>([
      ["", [e("scripts", "dir"), e("SKILL.md", "file", 100)]],
      ["scripts", [e("run.sh", "file", 50), e("lib", "dir")]],
    ]);
    expect(countTree(listing)).toEqual({ files: 2, dirs: 2, bytes: 150 });
    expect(countTree(new Map())).toEqual({ files: 0, dirs: 0, bytes: 0 });
  });
  test("isMultiFile", () => {
    expect(isMultiFile(1)).toBe(false);
    expect(isMultiFile(2)).toBe(true);
  });
});

describe("skill packs", () => {
  const pack = (over: Partial<SkillPack> = {}): SkillPack => ({ id: "pstack", title: "pstack", version: "0.15.36", author: "Lauren Tan", license: "MIT", upstream: "https://github.com/cursor/plugins/tree/main/pstack", commit: "c742dd6", skills: [], installed: 0, enabled: 0, ...over });
  const own = (name: string, over: Partial<PackableSkill> = {}): PackableSkill => ({ name, description: `${name} does things`, enabled: true, pack: null, ...over });
  const packed = (name: string, enabled = true): PackableSkill => own(name, { pack: "pstack", enabled });

  test("a search matches the name or the description, ignoring case and surrounding space; an empty one matches all", () => {
    expect(matchesSkill({ name: "tdd", description: "Red, green, refactor" }, "  RED ")).toBe(true);
    expect(matchesSkill({ name: "tdd", description: "x" }, "TD")).toBe(true);
    expect(matchesSkill({ name: "tdd", description: "x" }, "bug")).toBe(false);
    expect(matchesSkill({ name: "tdd", description: "x" }, "   ")).toBe(true);
  });

  test("the operator's own skills and the five built-ins stay in the flat list; pack skills do not", () => {
    const list = [own("alpha"), packed("architect"), own("design-critique", { description: "critique" })];
    expect(unpackedSkills(list, "").map((s) => s.name)).toEqual(["alpha", "design-critique"]);
    expect(unpackedSkills(list, "arch")).toEqual([]);
  });

  test("every shipped pack gets a section, titled and described by its manifest; the counts are its installed skills", () => {
    const sections = packSections([pack({ id: "zeta", title: "Zeta" }), pack({ installed: 2, enabled: 1, skills: ["tdd", "architect"] })], [packed("tdd", false), packed("architect"), own("alpha")], "");
    expect(sections.map((s) => s.id)).toEqual(["pstack", "zeta"]);
    expect(sections[0]).toMatchObject({ title: "pstack", version: "0.15.36", author: "Lauren Tan", license: "MIT", installed: 2, enabled: 1 });
    expect(sections[0].skills.map((s) => s.name)).toEqual(["tdd", "architect"]);
    expect(sections[1]).toMatchObject({ title: "Zeta", installed: 0, enabled: 0, skills: [] });
  });

  test("a search keeps only the packs it finds in and lists only the matching skills, but counts the whole pack", () => {
    const skills = [packed("tdd"), packed("architect", false), own("alpha")];
    const found = packSections([pack()], skills, "arch");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ installed: 2, enabled: 1 });
    expect(found[0].skills.map((s) => s.name)).toEqual(["architect"]);
    expect(packSections([pack()], skills, "nothing here")).toEqual([]);
  });

  test("a pack skill whose pack the list does not name still gets a section, titled by its id", () => {
    const [s] = packSections([], [packed("tdd")], "");
    expect(s).toMatchObject({ id: "pstack", title: "pstack", version: "", installed: 1, enabled: 1 });
  });

  test("the header reads the pack's count, and each button is offered only when it would change something", () => {
    expect(packCountText({ installed: 0, enabled: 0 })).toBe("none installed");
    expect(packCountText({ installed: 58, enabled: 3 })).toBe("3 of 58 enabled");
    expect(packActions({ installed: 58, enabled: 58 })).toEqual({ enable: false, disable: true });
    expect(packActions({ installed: 58, enabled: 0 })).toEqual({ enable: true, disable: false });
    expect(packActions({ installed: 58, enabled: 12 })).toEqual({ enable: true, disable: true });
    expect(packActions({ installed: 0, enabled: 0 })).toEqual({ enable: false, disable: false });
  });

  test("an upstream is a link only when it is http or https", () => {
    expect(safeHttpUrl("https://github.com/cursor/plugins/tree/main/pstack")).toBe("https://github.com/cursor/plugins/tree/main/pstack");
    expect(safeHttpUrl("http://example.com/x")).toBe("http://example.com/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<b>x</b>")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
  });
});
