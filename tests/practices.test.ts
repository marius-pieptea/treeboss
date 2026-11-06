import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { practicesRoutes } from "../src/daemon/routes/practices";
import { makeCtx, HttpError } from "../src/daemon/http";
import type { TurnResult } from "../src/engines/runner";
import { createLead, interruptAll, setTurnRunner } from "../src/sessions/manager";
import { getState } from "../src/treeboss/store";
import { UserError } from "../src/util";
import { bannedWords, checkFiles, checksFor, checksOf, dataInPresentational, fileTooLong, functionsTooLong, genericCta, imgWithoutAlt, multipleH1, noAny, practiceFindings, rawColors, runChecks, seoLinkText, seoMeta, skippedFiles, stripCode } from "../src/practices/checks";
import { changedFiles, repoFiles } from "../src/practices/files";
import { packById, PACK_OF_CHECK, PACKS, type PackDef } from "../src/practices/packs";
import { activeChecks, catalog, checkCustom, createCustom, deleteCustom, DEFAULT_THRESHOLDS, effectivePacks, forkBuiltin, practicesOf, resetBuiltin, saveBuiltin, setPractices, spliceBlock, START, END, updateCustom, type Pack } from "../src/practices/store";
import { validateRecipe } from "../src/scaffold/recipes";
import { home } from "../src/paths";
import { addRule, memoryView } from "../src/memory/store";
import { practiceLine } from "../src/treeboss/gate";
import { Workspaces } from "../src/workspaces";
import { makeDir, makeRepo, resetState } from "./helpers";

const HAND = "# My project\n\nHand-written notes.\n";
const pack = (id: string): Pack => ({ ...(packById(id) as PackDef), custom: false, modified: false, knownChecks: [...(packById(id)?.checks ?? [])] });
const lines = (n: number, head = "export function big(x: number) {") => [head, ...Array.from({ length: n - 2 }, (_, i) => `  const v${i} = x + ${i};`), "}"].join("\n");
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

describe("the built-in catalog", () => {
  test("fourteen packs, each with at most eight rules, and each check owned by one pack", () => {
    expect(PACKS.map((p) => p.id)).toEqual(["kiss", "yagni", "smart-dumb-components", "small-units", "feature-folders", "strict-types", "test-the-logic", "design-tokens", "a11y-basics", "ponytail", "pstack", "cro", "copywriting", "seo"]);
    for (const p of PACKS) {
      expect(p.rules.length).toBeGreaterThan(0);
      expect(p.rules.length).toBeLessThanOrEqual(8);
    }
    const owned = PACKS.flatMap((p) => p.checks ?? []);
    expect(new Set(owned).size).toBe(owned.length);
  });

  test("the ponytail pack keeps the skill's rules: smallest change, reuse first, a closing line on what was skipped", () => {
    const text = (packById("ponytail") as PackDef).rules.join("\n");
    expect(text).toMatch(/smallest change/);
    expect(text).toMatch(/Deletion beats addition/);
    expect(text).toMatch(/shortcut: <the limit>/);
    expect(text).toMatch(/what you skipped or did not check/);
  });

  test("the pstack pack is for every stack, with at most eight distinct rules and the principle skills it links", () => {
    const p = packById("pstack") as PackDef;
    expect(p.title).toBe("pstack principles");
    expect(p.appliesTo).toEqual(["any"]);
    expect(p.rules.length).toBeGreaterThan(0);
    expect(p.rules.length).toBeLessThanOrEqual(8);
    expect(new Set(p.rules).size).toBe(p.rules.length);
    expect(p.skills).toEqual([
      "principle-prove-it-works",
      "principle-fix-root-causes",
      "principle-attack-the-premise",
      "principle-test-behavior-not-implementation",
      "principle-sequence-verifiable-units",
      "principle-model-the-domain",
      "principle-minimize-reader-load",
      "principle-subtract-before-you-add",
      "principle-migrate-callers-then-delete-legacy-apis",
    ]);
  });

  test("the marketing packs are for web, each with its rules and the skills they name", () => {
    for (const id of ["cro", "copywriting", "seo"]) {
      const p = packById(id) as PackDef;
      expect(p.appliesTo).toEqual(["web"]);
      expect(p.rules.length).toBeGreaterThan(0);
      expect(p.rules.length).toBeLessThanOrEqual(8);
    }
    for (const id of ["cro", "copywriting", "seo"]) expect((packById(id) as PackDef).skills ?? []).toEqual([]);
    expect((packById("copywriting") as PackDef).rules.join("\n")).toMatch(/revolutionary, seamless, cutting-edge, unlock, elevate, leverage, robust, game-changer, empower, delve/);
  });

  test("the skills of a pack render as a line each after its rules; a pack without skills renders none", () => {
    const withSkills = { ...pack("copywriting"), skills: ["design-critique", "brand-extract"] };
    const out = spliceBlock("", [withSkills, pack("kiss")]);
    expect(out).toContain("- Use the design-critique skill if available.\n- Use the brand-extract skill if available.");
    const kissOnly = spliceBlock("", [pack("kiss")]);
    expect(kissOnly).not.toContain("skill if available");
    const ruleAt = out.indexOf("- Use plain words");
    expect(out.indexOf("- Use the design-critique")).toBeGreaterThan(ruleAt);
  });

  test("a custom pack with skills keeps them; one without keeps the old shape; a bad skill name is refused", () => {
    expect(checkCustom({ id: "with-skills", title: "x", rules: ["a"], skills: ["my-skill", "my-skill", " "] })).toEqual({ id: "with-skills", title: "x", summary: "", appliesTo: ["any"], rules: ["a"], skills: ["my-skill"] });
    expect(checkCustom({ id: "plain", title: "x", rules: ["a"] })).toEqual({ id: "plain", title: "x", summary: "", appliesTo: ["any"], rules: ["a"] });
    expect(() => checkCustom({ id: "bad-skill", title: "x", rules: ["a"], skills: ["-nope"] })).toThrow(/skill name/);
    expect(() => checkCustom({ id: "bad-skill", title: "x", rules: ["a"], skills: ["a --> b"] })).toThrow(/skill name/);
  });
});

describe("pure checks", () => {
  test("stripCode blanks comments and string contents, keeps line numbers, and ends a quote at its line", () => {
    const src = 'const a = "x!"; // any\n/* as any */ const b = `multi\nline`;\n<p>Don\'t</p>\nconst c = 1;';
    const out = stripCode(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).not.toContain("any");
    expect(out).not.toContain("x!");
    // The apostrophe in JSX text opens a string that ends with its line, so the next line is read as code again.
    expect(out.split("\n")[3]).toMatch(/^<p>Don' +$/);
    expect(out.split("\n")[4]).toBe("const c = 1;");
  });

  test("file length: over the limit is a finding, at the limit is not", () => {
    expect(fileTooLong(lines(301), 300)).toHaveLength(1);
    expect(fileTooLong(lines(300), 300)).toHaveLength(0);
  });

  test("function length flags the function by its start line, and a long block inside a short function is not a function", () => {
    expect(functionsTooLong(lines(61), 60)).toEqual([{ line: 1, message: expect.stringContaining("61 lines") }]);
    expect(functionsTooLong(lines(60), 60)).toEqual([]);
    const outer = ["function outer() {", "  if (x) {", ...Array.from({ length: 70 }, (_, i) => `    run(${i});`), "  }", "}"].join("\n");
    expect(functionsTooLong(outer, 60).map((h) => h.line)).toEqual([1]);
    const arrow = ["const f = (a) => {", ...Array.from({ length: 62 }, () => "  go();"), "};"].join("\n");
    expect(functionsTooLong(arrow, 60).map((h) => h.line)).toEqual([1]);
  });

  test("any and non-null assertions in type positions, not in strings, comments or !==", () => {
    expect(noAny("const a = x as any;").map((h) => h.line)).toEqual([1]);
    expect(noAny("function f(p: any) {}")).toHaveLength(1);
    expect(noAny("const s: Array<any> = [];")).toHaveLength(1);
    expect(noAny("const n = el!.value;")).toHaveLength(1);
    expect(noAny('const msg = "Done!";')).toHaveLength(0);
    expect(noAny("if (a !== b) {}")).toHaveLength(0);
    expect(noAny("// any type here, x!")).toHaveLength(0);
    expect(noAny("const x: unknown = 1;")).toHaveLength(0);
  });

  test("a presentational component that fetches or imports a data module is flagged; one that takes props is not", () => {
    expect(dataInPresentational("export function Card() {\n  const r = useQuery({ queryKey: ['x'] });\n  return null;\n}")).toHaveLength(1);
    expect(dataInPresentational('export function Card() {\n  fetch("/api/x");\n}')).toHaveLength(1);
    const imp = dataInPresentational('import { api } from "@/lib/api";\nexport const A = () => null;');
    expect(imp).toEqual([{ line: 1, message: expect.stringContaining("@/lib/api") }]);
    expect(dataInPresentational('import type { Pack } from "./data";')).toHaveLength(1);
    expect(dataInPresentational('import { Field } from "@/components/ui/form";\nexport const A = ({ label }: { label: string }) => <i>{label}</i>;')).toHaveLength(0);
    // The word fetch inside a string is not a call.
    expect(dataInPresentational('export const Hint = () => <p>"fetch(" is a word</p>;')).toHaveLength(0);
  });

  test("a container that owns its data and hands it to a child component is skipped; a presentational one that fetches inside is flagged", () => {
    const container = [
      'import { PackTile } from "./PackTile";',
      "export function PackCard({ id }: { id: string }) {",
      "  const { data: pack, isLoading } = useQuery({ queryKey: ['pack', id] });",
      "  return <PackTile pack={pack} loading={isLoading} />;",
      "}",
    ].join("\n");
    expect(dataInPresentational(container)).toHaveLength(0);
    const awaited = ['import { Row } from "./Row";', "export async function ListCard() {", '  const res = await fetch("/x");', "  return <Row rows={res} />;", "}"].join("\n");
    expect(dataInPresentational(awaited)).toHaveLength(0);
    const inline = ["export function PackCard({ id }: { id: string }) {", "  const { data } = useQuery({ queryKey: ['pack', id] });", "  return <p>{data?.name}</p>;", "}"].join("\n");
    expect(dataInPresentational(inline)).toHaveLength(1);
    const unrelated = ['import { Icon } from "./Icon";', "export function PackCard() {", "  const { data } = useQuery({ queryKey: ['p'] });", '  return <Icon name="x" />;', "}"].join("\n");
    expect(dataInPresentational(unrelated)).toHaveLength(1);
    const apiImport = ['import { api } from "@/lib/api";', "export const A = () => <Row rows={api} />;"].join("\n");
    expect(dataInPresentational(apiImport)).toHaveLength(1);
  });

  test("raw hex and rgb colors are findings; token references and #anchors are not", () => {
    expect(rawColors('<div style={{ color: "#fff" }} />')).toHaveLength(1);
    expect(rawColors("background: rgba(0, 0, 0, 0.1);")).toHaveLength(1);
    expect(rawColors("color: var(--color-text);")).toHaveLength(0);
    expect(rawColors('<a href="#main">x</a>')).toHaveLength(0);
  });

  test("an img without alt is a finding; alt, an empty alt, a multi-line alt and a spread do not count as missing", () => {
    expect(imgWithoutAlt('<img src="/a.png" />')).toHaveLength(1);
    expect(imgWithoutAlt('<img src="/a.png" alt="A cat" />')).toHaveLength(0);
    expect(imgWithoutAlt('<img src="/a.png" alt="" />')).toHaveLength(0);
    expect(imgWithoutAlt('<img\n  src="/a.png"\n  alt="Logo"\n/>')).toHaveLength(0);
    expect(imgWithoutAlt("<img {...props} />")).toHaveLength(0);
    expect(imgWithoutAlt('<img data-alt="x" src="/a" />')).toHaveLength(1);
  });

  test("checksOf keeps only the checks of the packs given", () => {
    expect(checksOf(["small-units"])).toEqual(["file-length", "function-length"]);
    expect(checksOf(["kiss", "ponytail"])).toEqual([]);
    expect(checksOf(["cro", "copywriting", "seo"])).toEqual(["banned-words", "generic-cta", "seo-meta", "multiple-h1", "seo-link-text"]);
  });

  test("banned-words: a ban-list word in copy is a finding, with its inflections; in an identifier or a comment it is not", () => {
    expect(bannedWords("<p>Our platform is robust and seamless.</p>", "page.tsx").map((h) => h.line)).toEqual([1, 1]);
    expect(bannedWords('const label = "Unlock your data";', "page.tsx")).toHaveLength(1);
    expect(bannedWords("<p>Leveraging the cloud</p>", "page.tsx")).toHaveLength(1);
    expect(bannedWords("export const onUnlock = () => {};\nconst unlock_all = 1;", "page.tsx")).toHaveLength(0);
    expect(bannedWords("// this is robust\n/* empower */ const a = 1;", "page.tsx")).toHaveLength(0);
    expect(bannedWords('import { unlock } from "./unlock";', "page.tsx")).toHaveLength(0);
    expect(bannedWords('<a href="/robust-plan">Pricing</a>', "page.tsx")).toHaveLength(0);
    // A URL in copy does not start a comment, so the word after it is still read.
    expect(bannedWords("<p>See https://x.io, then robust</p>", "page.tsx")).toHaveLength(1);
    expect(bannedWords("# Title\n\nWe delve into the data.\n\n```\nrobust()\n```\n", "post.md")).toEqual([{ line: 3, message: expect.stringContaining("delve") }]);
    expect(bannedWords("<p>Built to delight</p>", "index.html")).toHaveLength(0);
  });

  test("generic-cta: a button or link whose whole text is Submit, Learn more and the like; an outcome or a sentence is fine", () => {
    expect(genericCta('<button type="submit" onClick={() => go()}>Submit</button>', "page.tsx")).toHaveLength(1);
    expect(genericCta('<a href="/x">Learn more</a>', "page.html")).toHaveLength(1);
    expect(genericCta('<Button>{"Click here"}</Button>', "page.tsx")).toHaveLength(1);
    expect(genericCta("[Read more](/x)", "post.md")).toHaveLength(1);
    expect(genericCta('<Button>Start free trial</Button>\n<a href="/x">Get my audit</a>', "page.tsx")).toHaveLength(0);
    expect(genericCta("<p>Submit your details</p>", "page.tsx")).toHaveLength(0);
    expect(genericCta("![Go](/arrow.png)", "post.md")).toHaveLength(0);
  });

  test("seo-link-text: a link whose text is here or click here; a button or a named link is fine", () => {
    expect(seoLinkText('<a href="/pricing">click here</a>', "page.tsx")).toHaveLength(1);
    expect(seoLinkText('<Link href="/x">here</Link>', "page.tsx")).toHaveLength(1);
    expect(seoLinkText("[here](/pricing)", "post.md")).toHaveLength(1);
    expect(seoLinkText("<button>here</button>", "page.tsx")).toHaveLength(0);
    expect(seoLinkText('<a href="/pricing">Pricing for teams</a>', "page.tsx")).toHaveLength(0);
  });

  test("seo-meta: a Next.js page exports metadata or generateMetadata; an html page has a title and a meta description", () => {
    expect(seoMeta("export const metadata = { title: 'Pricing' };", "app/pricing/page.tsx")).toHaveLength(0);
    expect(seoMeta("export async function generateMetadata() { return {}; }", "app/page.tsx")).toHaveLength(0);
    expect(seoMeta("export { metadata };", "app/page.tsx")).toHaveLength(0);
    expect(seoMeta("export default function Page() { return null; }", "app/pricing/page.tsx")).toEqual([{ line: 1, message: expect.stringContaining("metadata") }]);
    // A commented-out export is not an export.
    expect(seoMeta("// export const metadata = {};\nexport default function Page() {}", "app/page.tsx")).toHaveLength(1);
    expect(seoMeta('<html><head><title>Invoices</title><meta name="description" content="x" /></head></html>', "index.html")).toHaveLength(0);
    expect(seoMeta('<html><head><meta name="description" content="x"></head></html>', "index.html").map((h) => h.message)).toEqual([expect.stringContaining("<title>")]);
    expect(seoMeta("<html><head><title>Invoices</title></head></html>", "index.html").map((h) => h.message)).toEqual([expect.stringContaining("description")]);
  });

  test("multiple-h1: each H1 after the first is a finding, on its own line; one H1 is not", () => {
    expect(multipleH1("<h1>Invoices</h1>\n<h1>Pricing</h1>\n<h1>x</h1>", "index.html").map((h) => h.line)).toEqual([2, 3]);
    expect(multipleH1("export default function Page() {\n  return <h1>Invoices</h1>;\n}", "app/page.tsx")).toHaveLength(0);
    expect(multipleH1("export default function Page() {\n  return <><h1>A</h1>\n<h1>B</h1></>;\n}", "app/pricing/page.tsx").map((h) => h.line)).toEqual([3]);
    // A commented-out heading is not one.
    expect(multipleH1("<h1>One</h1>\n<!-- <h1>Old</h1> -->", "index.html")).toHaveLength(0);
  });
});

describe("runChecks over files", () => {
  test("each check reads only the files it applies to", () => {
    const root = makeRepo({
      "src/big.ts": lines(301),
      "web/src/components/ui/Thing.tsx": 'import { api } from "@/lib/api";\nexport const T = () => <img src="/x" />;\n',
      "web/src/features/x/app.css": "h1 { color: #abc; }\n",
      "design/tokens.css": "--color-a: #fff;\n",
    });
    const all = [...checksOf(["small-units", "smart-dumb-components", "design-tokens", "a11y-basics"])];
    const found = runChecks(root, ["src/big.ts", "web/src/components/ui/Thing.tsx", "web/src/features/x/app.css", "design/tokens.css", "gone.ts"], all, DEFAULT_THRESHOLDS);
    const byFile = (f: string) => found.filter((x) => x.file === f).map((x) => `${x.packId}:${x.check}`);
    expect(byFile("src/big.ts")).toEqual(["small-units:file-length", "small-units:function-length"]);
    expect(byFile("web/src/components/ui/Thing.tsx").sort()).toEqual(["a11y-basics:img-alt", "smart-dumb-components:presentational-data"]);
    expect(byFile("web/src/features/x/app.css")).toEqual(["design-tokens:raw-color"]);
    expect(byFile("design/tokens.css")).toEqual([]);
  });

  test("the marketing checks read the files they apply to: page files for SEO, copy files for words and CTAs", () => {
    const root = makeRepo({
      "web/app/pricing/page.tsx": "export default function P() {\n  return <h1>Plans</h1>;\n}\n",
      "web/app/pricing/Hero.tsx": "export const Hero = () => <button>Submit</button>;\n<h1>x</h1>\n<h1>y</h1>\n",
      "web/public/index.html": "<h1>A</h1><h1>B</h1>\n",
      "content/post.md": "[click here](/x)\n\nWe leverage it.\n",
    });
    const files = ["web/app/pricing/page.tsx", "web/app/pricing/Hero.tsx", "web/public/index.html", "content/post.md"];
    const found = runChecks(root, files, checksOf(["cro", "copywriting", "seo"]), DEFAULT_THRESHOLDS);
    expect(found.map((f) => `${f.file}:${f.check}`).sort()).toEqual([
      "content/post.md:banned-words",
      "content/post.md:generic-cta",
      "content/post.md:seo-link-text",
      "web/app/pricing/Hero.tsx:generic-cta",
      "web/app/pricing/page.tsx:seo-meta",
      "web/public/index.html:multiple-h1",
      "web/public/index.html:seo-meta",
      "web/public/index.html:seo-meta",
    ]);
    expect(found.every((f) => f.packId === PACK_OF_CHECK[f.check])).toBe(true);
  });

  test("the whole repo means tracked and untracked files that git does not ignore; changed means uncommitted", () => {
    const root = makeRepo({ "a.ts": "export const a = 1;\n", ".gitignore": "ignored.ts\n" });
    fs.writeFileSync(path.join(root, "ignored.ts"), "x\n");
    fs.writeFileSync(path.join(root, "b.ts"), "y\n");
    expect(repoFiles(root).sort()).toEqual([".gitignore", "a.ts", "b.ts"]);
    expect(changedFiles(root).sort()).toEqual(["b.ts"]);
  });
});

describe("the managed block", () => {
  test("appends after hand-written text, which stays byte for byte; removing the packs restores it", () => {
    const one = spliceBlock(HAND, [pack("kiss")]);
    expect(one.startsWith(HAND)).toBe(true);
    expect(one).toContain("### KISS");
    expect(spliceBlock(one, [])).toBe(HAND);
  });

  test("idempotent: the same packs again give the same bytes", () => {
    const once = spliceBlock(HAND, [pack("kiss"), pack("yagni")]);
    expect(spliceBlock(once, [pack("kiss"), pack("yagni")])).toBe(once);
  });

  test("the memory block is left exactly where it is", () => {
    const memory = "<!-- trb:memory:start -->\n## Project rules\n- We use bun.\n<!-- trb:memory:end -->\n";
    const out = spliceBlock(memory, [pack("small-units")]);
    expect(out.startsWith(memory)).toBe(true);
  });

  test("a damaged block is refused rather than guessed at", () => {
    expect(() => spliceBlock(`${START}\n- x\n`, [pack("kiss")])).toThrow(/damaged/);
  });

  test("CRLF files keep CRLF", () => {
    const out = spliceBlock("# t\r\n\r\nbody\r\n", [pack("kiss")]);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("settings per workspace", () => {
  let dir: string;
  let ws: string;
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf-8");
  beforeEach(() => {
    dir = makeDir();
    ws = Workspaces.open(dir).id;
  });

  test("enabling writes the block into AGENTS.md and CLAUDE.md; disabling takes it out again", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), HAND);
    addRule(dir, "We use bun, not npm.");
    const before = read("AGENTS.md");
    setPractices(ws, { enabled: ["kiss"] });
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      expect(read(f)).toContain(START);
      expect(read(f)).toContain("### KISS");
      // The memory block is still there, byte for byte.
      expect(read(f)).toContain("- We use bun, not npm.");
    }
    setPractices(ws, { enabled: [] });
    expect(read("AGENTS.md")).toBe(before);
    expect(memoryView(dir).rules.map((r) => r.text)).toEqual(["We use bun, not npm."]);
  });

  test("enabling pstack writes its heading, every rule and its skill lines into AGENTS.md and CLAUDE.md; disabling takes them out again", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), HAND);
    addRule(dir, "We use bun, not npm.");
    const before = read("AGENTS.md");
    const p = packById("pstack") as PackDef;
    setPractices(ws, { enabled: ["pstack"] });
    for (const f of ["AGENTS.md", "CLAUDE.md"]) {
      expect(read(f)).toContain(START);
      expect(read(f)).toContain("### pstack principles");
      for (const r of p.rules) expect(read(f)).toContain(`- ${r}`);
      expect(read(f)).toContain("- Use the principle-prove-it-works skill if available.");
      // The memory block is still there, byte for byte.
      expect(read(f)).toContain("- We use bun, not npm.");
    }
    setPractices(ws, { enabled: [] });
    expect(read("AGENTS.md")).toBe(before);
  });

  test("enabling twice writes the same bytes, and a file that only held the block is removed with it", () => {
    setPractices(ws, { enabled: ["kiss"] });
    const once = read("AGENTS.md");
    setPractices(ws, { enabled: ["kiss"] });
    expect(read("AGENTS.md")).toBe(once);
    setPractices(ws, { enabled: [] });
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);
  });

  test("enabled must be a list; a string is refused, not read as no packs", () => {
    expect(() => setPractices(ws, { enabled: "kiss" })).toThrow(/list of pack ids/);
    expect(practicesOf(ws).enabled).toEqual([]);
  });

  test("an unknown pack id is refused and nothing is written", () => {
    expect(() => setPractices(ws, { enabled: ["kiss", "nope"] })).toThrow(/No practice pack "nope"/);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
    expect(practicesOf(ws).enabled).toEqual([]);
  });

  test("thresholds are whole numbers in range; a field left out keeps its value", () => {
    expect(() => setPractices(ws, { thresholds: { maxFileLines: 2 } })).toThrow(/maxFileLines/);
    setPractices(ws, { thresholds: { maxFileLines: 120 } });
    setPractices(ws, { thresholds: { maxFunctionLines: 40 } });
    expect(practicesOf(ws).thresholds).toEqual({ maxFileLines: 120, maxFunctionLines: 40 });
  });

  test("practiceFindings: nothing enabled means nothing read; enabled, the workspace's threshold applies", () => {
    fs.writeFileSync(path.join(dir, "big.ts"), lines(12));
    expect(practiceFindings(dir, ["big.ts"])).toEqual([]);
    setPractices(ws, { enabled: ["small-units"], thresholds: { maxFileLines: 10 } });
    const found = practiceFindings(dir, ["big.ts"]);
    // Only the file limit was lowered; the function (12 lines) is under the default 60.
    expect(found.map((f) => [f.packId, f.check])).toEqual([["small-units", "file-length"]]);
    expect(practiceLine(found[0]!)).toMatch(/^\[small-units\] big\.ts/);
  });

  test("a broken practices.json never fails a turn: the findings are empty", () => {
    fs.writeFileSync(path.join(dir, "big.ts"), lines(400));
    setPractices(ws, { enabled: ["small-units"] });
    expect(practiceFindings(dir, ["big.ts"]).length).toBeGreaterThan(0);
    const file = path.join(home(), "practices.json");
    fs.writeFileSync(file, "{ not json");
    try {
      expect(practiceFindings(dir, ["big.ts"])).toEqual([]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("custom packs", () => {
  test("create, enable (its rules go into the block), update, and delete (switched off where it was on)", () => {
    const dir = makeDir();
    const ws = Workspaces.open(dir).id;
    createCustom({ id: "no-barrels", title: "No barrels", summary: "Import from the file, not an index.", rules: ["Import from the defining file, never an index.ts re-export."] });
    expect(catalog().some((p) => p.id === "no-barrels" && p.custom)).toBe(true);
    setPractices(ws, { enabled: ["no-barrels"] });
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toContain("Import from the defining file");

    updateCustom("no-barrels", { title: "No barrel files", rules: ["Import from the defining file."] });
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8")).toContain("### No barrel files");

    deleteCustom("no-barrels");
    expect(practicesOf(ws).enabled).toEqual([]);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(false);
  });

  test("a built-in id cannot be taken, rules have a count and a size, and HTML comment markers are refused", () => {
    expect(() => checkCustom({ id: "kiss", title: "x", rules: ["a"] })).toThrow(/built-in/);
    expect(() => checkCustom({ id: "ok-pack", title: "x", rules: [] })).toThrow(/1 to 8 rules/);
    expect(() => checkCustom({ id: "ok-pack", title: "x", rules: Array.from({ length: 9 }, (_, i) => `r${i}`) })).toThrow(/1 to 8 rules/);
    expect(() => checkCustom({ id: "ok-pack", title: "x", rules: ["a --> b"] })).toThrow(/comment markers/);
    expect(() => checkCustom({ id: "Bad Id", title: "x", rules: ["a"] })).toThrow(/pack id/);
  });
});

/**
 * The routes are called straight from their module, so this suite does not depend on server.ts listing them (the
 * registration line is in the report). HttpError and UserError become the status the server would send.
 */
describe("HTTP routes", () => {
  const call = async (method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const url = new URL(`http://trb.test${p}`);
    const ctx = makeCtx(new Request(url, { method }), url, (body as Record<string, any>) ?? {});
    try {
      const res = await practicesRoutes(ctx);
      if (!res) throw new Error(`no route for ${method} ${p}`);
      return { status: res.status, body: await res.json() };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
      if (err instanceof UserError) return { status: 400, body: { error: err.message } };
      throw err;
    }
  };

  test("catalog, enable, check the whole repo, then the path rules", async () => {
    const repo = makeRepo({ "src/big.ts": lines(400), "src/ok.ts": "export const ok = 1;\n" });
    const ws = Workspaces.open(repo).id;

    let r = await call("GET", "/api/practices");
    expect(r.body.packs.map((p: any) => p.id)).toContain("kiss");
    expect(r.body.defaults).toEqual(DEFAULT_THRESHOLDS);

    r = await call("PUT", `/api/workspaces/${ws}/practices`, { enabled: ["small-units"] });
    expect(r.body.enabled).toEqual(["small-units"]);
    expect(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf-8")).toContain(START);

    r = await call("POST", `/api/workspaces/${ws}/practices/check`, {});
    expect(r.body.findings.map((f: any) => [f.packId, f.file, f.check])).toEqual([
      ["small-units", "src/big.ts", "file-length"],
      ["small-units", "src/big.ts", "function-length"],
    ]);

    r = await call("POST", `/api/workspaces/${ws}/practices/check`, { files: ["../etc/passwd"] });
    expect(r.status).toBe(400);
    r = await call("POST", `/api/workspaces/${ws}/practices/check`, { files: ["src/ok.ts"] });
    expect(r.body.findings).toEqual([]);

    r = await call("GET", "/api/workspaces/w_nope/practices");
    expect(r.status).toBe(404);
  });

  test("custom pack CRUD over HTTP", async () => {
    let r = await call("POST", "/api/practices/custom", { id: "http-pack", title: "HTTP pack", rules: ["Say what you mean."] });
    expect(r.status).toBe(201);
    r = await call("POST", "/api/practices/custom", { id: "http-pack", title: "HTTP pack", rules: ["Say what you mean."] });
    expect(r.status).toBe(400);
    r = await call("PUT", "/api/practices/custom/http-pack", { title: "HTTP pack two", rules: ["Say it plainly."] });
    expect(r.body.pack.title).toBe("HTTP pack two");
    r = await call("DELETE", "/api/practices/custom/http-pack");
    expect(r.status).toBe(200);
    r = await call("PUT", "/api/practices/custom/http-pack", { title: "gone", rules: ["x"] });
    expect(r.status).toBe(400);
  });

  test("the catalog says what enforce mode is the default and which checks exist", async () => {
    const r = await call("GET", "/api/practices");
    expect(r.body.enforce).toBe("warn");
    expect(r.body.checkIds).toContain("no-any");
    expect(r.body.packs.find((p: Pack) => p.id === "strict-types")).toMatchObject({ modified: false, custom: false, knownChecks: ["no-any"] });
  });

  test("a built-in pack is edited in place over HTTP (modified), forked into a custom copy, and reset", async () => {
    const shipped = packById("strict-types") as PackDef;
    let r = await call("PUT", "/api/practices/packs/strict-types", { title: "Strict types", summary: shipped.summary, appliesTo: shipped.appliesTo, rules: [...shipped.rules, "Name the type."], skills: [], checks: ["no-any"] });
    expect(r.status).toBe(200);
    expect(r.body.pack).toMatchObject({ id: "strict-types", modified: true });
    expect(r.body.pack.rules).toHaveLength(shipped.rules.length + 1);

    r = await call("POST", "/api/practices/packs/strict-types/fork", { id: "strict-mine" });
    expect(r.status).toBe(201);
    expect(r.body.pack).toMatchObject({ id: "strict-mine", custom: true });
    expect(r.body.pack.checks).toBeUndefined();

    r = await call("POST", "/api/practices/packs/strict-types/reset", {});
    expect(r.body.pack).toMatchObject({ modified: false });
    expect(r.body.pack.rules).toEqual(shipped.rules);

    r = await call("DELETE", "/api/practices/packs/strict-mine");
    expect(r.status).toBe(200);
    r = await call("DELETE", "/api/practices/packs/strict-types");
    expect(r.status).toBe(400);
  });

  test("a workspace's enforce mode and switches are saved over HTTP, and a bad mode is refused", async () => {
    const id = Workspaces.open(makeRepo({ "a.txt": "x\n" })).id;
    let r = await call("PUT", `/api/workspaces/${id}/practices`, { enabled: ["strict-types"], enforce: "fix", off: { "strict-types": { rules: [], checks: ["no-any"] } } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: ["strict-types"], enforce: "fix", off: { "strict-types": { rules: [], checks: ["no-any"] } } });
    r = await call("GET", `/api/workspaces/${id}/practices`);
    expect(r.body.enforce).toBe("fix");
    r = await call("PUT", `/api/workspaces/${id}/practices`, { enforce: "loud" });
    expect(r.status).toBe(400);
  });
});

describe("the treeboss gate", () => {
  const result = (output = "ok"): TurnResult => ({ success: true, output, sessionId: "cli-1", resumeRejected: false, aborted: false, timedOut: false, maxTurnsHit: false, usage: null, exitCode: 0, stderr: "" });
  /** Poll until `check` holds, or fail after 20 seconds. */
  async function until(check: () => boolean, label: string) {
    const end = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
      await Bun.sleep(25);
    }
  }
  beforeEach(() => {
    resetState();
    setTurnRunner(null);
  });
  afterEach(async () => {
    await interruptAll();
    setTurnRunner(null);
  });

  test("a violation of an enabled pack goes back to the agent as a labelled fix turn, and the fix passes", async () => {
    const dir = makeRepo({ "src/base.ts": "export const a = 1;\n" });
    // enforce defaults to warn (reported only): this test is about a finding that goes back to the agent.
    setPractices(Workspaces.open(dir).id, { enabled: ["small-units"], enforce: "fix", thresholds: { maxFileLines: 10 } });
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      o.onLog?.("TREEBOSS_TIER: tweak");
      write(o.cwd, "src/long.ts", prompts.length === 1 ? lines(12) : "export const ok = 1;\n");
      return result("Done.");
    });
    const s = createLead({ prompt: "add a file", engine: "fake", cwd: dir, treeboss: true });
    await until(() => getState(s.id).lastCheck?.outcome === "passed" && prompts.length === 2, "the fix turn to pass");
    expect(prompts[1]).toContain("- [small-units] src/long.ts file is 12 lines (max 10)");
  });

  test("with no pack on, the same turn is not checked for practices and passes at once", async () => {
    const dir = makeRepo({ "src/base.ts": "export const a = 1;\n" });
    Workspaces.open(dir);
    const prompts: string[] = [];
    setTurnRunner(async (o) => {
      prompts.push(o.prompt);
      o.onLog?.("TREEBOSS_TIER: tweak");
      write(o.cwd, "src/long.ts", lines(400));
      return result("Done.");
    });
    const s = createLead({ prompt: "add a file", engine: "fake", cwd: dir, treeboss: true });
    await until(() => getState(s.id).lastCheck?.outcome === "passed", "the gate to record the turn");
    expect(prompts.length).toBe(1);
  });
});

describe("template files", () => {
  const TEMPLATES = ["a.twig", "a.blade.php", "a.html.erb", "a.jinja", "a.jinja2", "a.j2", "a.njk", "a.liquid", "a.hbs", "a.mustache", "a.gohtml", "a.tmpl", "a.php", "a.vue", "a.svelte", "a.astro"];

  test("every template dialect is read by the copy, link, alt, color and SEO checks; the TS-only checks skip it", () => {
    for (const f of TEMPLATES) {
      expect(checksFor(f)).toEqual(expect.arrayContaining(["file-length", "img-alt", "raw-color", "banned-words", "generic-cta", "seo-meta", "seo-link-text"]));
      expect(checksFor(f)).not.toContain("no-any");
      expect(checksFor(f)).not.toContain("function-length");
    }
    expect(checksFor("components/Card.vue")).toContain("presentational-data");
    expect(checksFor("views/page.twig")).not.toContain("presentational-data");
    expect(checksFor("README.md")).toEqual(["banned-words", "generic-cta", "seo-link-text"]);
  });

  test("twig: template tags, comments and attribute syntax are never flagged; the visible copy around them is", () => {
    const page = [
      "{# Hero draft: robust, seamless #}",
      '{% set label = "Submit" %}',
      "<p>{{ 'Our platform is robust' }}</p>",
      "<p>Our platform is robust.</p>",
      '<button type="submit">{{ label }}</button>',
      '<button type="submit">Submit</button>',
      '<a href="/pricing">{{ "click here" }}</a>',
      '<a href="/pricing">click here</a>',
      "<style>{# color: #fff #}",
      "  .x { color: #123456; }</style>",
    ].join("\n");
    expect(bannedWords(page, "pages/home.html.twig").map((h) => h.line)).toEqual([4]);
    expect(genericCta(page, "pages/home.html.twig").map((h) => h.line)).toEqual([6, 8]);
    expect(seoLinkText(page, "pages/home.html.twig").map((h) => h.line)).toEqual([8]);
    expect(rawColors(page, "pages/home.html.twig").map((h) => h.line)).toEqual([10]);
  });

  test("twig: an img with a template in its src still needs an alt; a bare tag in the attributes may carry one", () => {
    const text = '<img src="{{ url }}">\n<img {{ attrs }}>\n<img src="{{ url }}" alt="{{ label }}">\n<img src="/a.png">';
    expect(imgWithoutAlt(text, "partials/card.html.twig").map((h) => h.line)).toEqual([1, 4]);
  });

  test("twig: a page that extends a layout is read for its own h1s; a partial with two h1s is not a page", () => {
    const page = '{% extends "layouts/app.html.twig" %}\n{% block body %}<h1>A</h1>\n<h1>B</h1>{% endblock %}';
    expect(multipleH1(page, "pages/home.html.twig").map((h) => h.line)).toEqual([3]);
    expect(multipleH1("<h1>A</h1>\n<h1>B</h1>", "partials/hero.html.twig")).toEqual([]);
  });

  test("the layout's title and meta description cover the page that extends it; a layout without them is reported on its page", () => {
    const root = makeRepo({
      "templates/layouts/base.html.twig": '<html><head><title>{% block title %}Acme{% endblock %}</title><meta name="description" content="{% block description %}{% endblock %}"></head><body>{% block body %}{% endblock %}</body></html>\n',
      "templates/pricing.html.twig": '{% extends "layouts/base.html.twig" %}\n{% block title %}Pricing{% endblock %}\n{% block body %}<p>Plans</p>{% endblock %}\n',
      "templates/broken.html.twig": '{% extends "layouts/bare.html.twig" %}\n{% block body %}<p>Plans</p>{% endblock %}\n',
      "templates/layouts/bare.html.twig": "<html><head></head><body>{% block body %}{% endblock %}</body></html>\n",
    });
    const files = ["templates/layouts/base.html.twig", "templates/pricing.html.twig", "templates/broken.html.twig", "templates/layouts/bare.html.twig"];
    const seo = runChecks(root, files, checksOf(["seo"]), DEFAULT_THRESHOLDS).filter((f) => f.check === "seo-meta");
    // The bare layout is a document with no head meta of its own, so it is reported; the broken page is reported through it.
    expect(seo.map((f) => f.file).sort()).toEqual(["templates/broken.html.twig", "templates/broken.html.twig", "templates/layouts/bare.html.twig", "templates/layouts/bare.html.twig"]);
    expect(seo.find((f) => f.file === "templates/broken.html.twig")?.message).toContain("templates/layouts/bare.html.twig is this page's layout");
  });

  test("blade: a page that extends layouts.app is covered by the layout's yielded title and description; a Blade directive is not copy", () => {
    const root = makeRepo({
      "resources/views/layouts/app.blade.php": "<html><head><title>@yield('title', 'Acme')</title><meta name=\"description\" content=\"@yield('description')\"></head><body>@yield('content')</body></html>\n",
      "resources/views/pricing.blade.php": "@extends('layouts.app')\n@section('title', 'Pricing')\n@section('content')\n@if($plans->count())\n<p>Plans</p>\n@endif\n@endsection\n",
      "resources/views/landing.blade.php": "@extends('layouts.bare')\n@section('content')<p>Hi</p>@endsection\n",
      "resources/views/layouts/bare.blade.php": "<html><head></head><body>@yield('content')</body></html>\n",
    });
    const found = runChecks(root, ["resources/views/pricing.blade.php", "resources/views/landing.blade.php"], checksOf(["seo"]), DEFAULT_THRESHOLDS);
    expect(found.filter((f) => f.check === "seo-meta" && f.file === "resources/views/pricing.blade.php")).toEqual([]);
    expect(found.filter((f) => f.check === "seo-meta" && f.file === "resources/views/landing.blade.php").map((f) => f.message)).toEqual([expect.stringContaining("layouts/bare.blade.php"), expect.stringContaining("layouts/bare.blade.php")]);
    const copy = '@php $label = "robust";\n@endphp\n<p>@if($a) Seamless @endif</p>\n<p>mail me@example.com</p>';
    expect(bannedWords(copy, "resources/views/x.blade.php").map((h) => h.line)).toEqual([3]);
  });

  test("erb: a view that sets content_for :title gets the application layout; ERB comments and tags are not copy", () => {
    const root = makeRepo({
      "app/views/layouts/application.html.erb": '<!DOCTYPE html><html><head><title><%= yield(:title) %></title><meta name="description" content="<%= yield :description %>"></head><body><%= yield %></body></html>\n',
      "app/views/pages/pricing.html.erb": '<% content_for :title, "Pricing" %>\n<h1>Plans</h1>\n<%# seamless robust %>\n<a href="/x">click here</a>\n',
      "app/views/shared/_nav.html.erb": '<a href="/x"><%= t("nav.home") %></a>\n',
    });
    const found = runChecks(root, ["app/views/pages/pricing.html.erb", "app/views/shared/_nav.html.erb"], checksOf(["seo", "copywriting"]), DEFAULT_THRESHOLDS);
    expect(found.filter((f) => f.check === "seo-meta")).toEqual([]);
    expect(found.map((f) => `${f.check}:${f.line}`).sort()).toEqual(["seo-link-text:4"]);
    expect(bannedWords('<%# seamless robust %>\n<p><%= t("x") %> robust</p>', "app/views/pages/a.html.erb").map((h) => h.line)).toEqual([2]);
  });

  test("jinja and liquid: a comment, a {# #} or a {% comment %} body is never copy", () => {
    expect(bannedWords("{# robust #}\n{{ robust }}\n<p>Seamless plans</p>\n", "base.jinja2").map((h) => h.line)).toEqual([3]);
    expect(bannedWords("{% comment %}Elevate the plan{% endcomment %}\n<p>Plain words</p>\n", "page.liquid")).toEqual([]);
    expect(genericCta('<button>{{ "Submit" }}</button>\n<button>Submit</button>', "form.njk").map((h) => h.line)).toEqual([2]);
  });

  test("vue: the template is copy and its img is checked; the script is not copy; a :alt binding counts", () => {
    const sfc = [
      "<template>",
      '  <div class="card">',
      '    <img src="/logo.png">',
      '    <img :alt="label" src="/a.png">',
      "    <p>Seamless delivery</p>",
      "  </div>",
      "</template>",
      '<script setup lang="ts">',
      'const note = "robust";',
      "</script>",
      "<style scoped>",
      ".card { color: #123456; }",
      "</style>",
    ].join("\n");
    expect(imgWithoutAlt(sfc, "components/Card.vue").map((h) => h.line)).toEqual([3]);
    expect(bannedWords(sfc, "components/Card.vue").map((h) => h.line)).toEqual([5]);
    expect(rawColors(sfc, "components/Card.vue").map((h) => h.line)).toEqual([12]);
  });

  test("vue: a component that fetches is flagged, as tsx is; the same code in a page folder is not a component", () => {
    const root = makeRepo({ "web/components/Card.vue": '<template><p>x</p></template>\n<script>\nexport default { mounted() { fetch("/api/x"); } };\n</script>\n' });
    const found = runChecks(root, ["web/components/Card.vue"], checksOf(["smart-dumb-components"]), DEFAULT_THRESHOLDS);
    expect(found.map((f) => [f.check, f.line])).toEqual([["presentational-data", 3]]);
  });

  test("astro: the frontmatter is code and not copy; markup is copy; a <Layout> that defines title and description covers the page", () => {
    const root = makeRepo({
      "src/layouts/Layout.astro": '<html><head><title>{title}</title><meta name="description" content={description}></head><body><slot /></body></html>\n',
      "src/layouts/Bare.astro": "<html><head></head><body><slot /></body></html>\n",
      "src/pages/pricing.astro": '---\nimport Layout from "../layouts/Layout.astro";\nconst note = "robust";\n---\n<Layout title="Pricing">\n  <p>{plan.name} is seamless</p>\n  <a href="/x">here</a>\n</Layout>\n',
      "src/pages/bare-page.astro": '---\nimport Layout from "../layouts/Bare.astro";\n---\n<Layout title="Plain"><p>Hi</p></Layout>\n',
    });
    const page = '---\nimport Layout from "../layouts/Layout.astro";\nconst note = "robust";\n---\n<Layout title="Pricing">\n  <p>{plan.name} is seamless</p>\n  <a href="/x">here</a>\n</Layout>\n';
    expect(bannedWords(page, "src/pages/pricing.astro").map((h) => h.line)).toEqual([6]);
    expect(seoLinkText(page, "src/pages/pricing.astro").map((h) => h.line)).toEqual([7]);
    const found = runChecks(root, ["src/pages/pricing.astro", "src/pages/bare-page.astro"], checksOf(["seo"]), DEFAULT_THRESHOLDS);
    // The Bare layout is itself a document with no title or description, so it is reported; the page is reported through it.
    expect(found.filter((f) => f.check === "seo-meta").map((f) => f.file).sort()).toEqual(["src/pages/bare-page.astro", "src/pages/bare-page.astro"]);
  });

  test("php: only the HTML parts are read; a PHP string, and a PHP-built head, are not copy or a missing title", () => {
    const page = ["<?php", '$label = "robust";', "?>", "<h1>Plans</h1>", "<p>Our robust plans <?= $label ?></p>", '<a href="/x"><?= "click here" ?></a>', '<img src="/a.png">'].join("\n");
    expect(bannedWords(page, "views/plans.php").map((h) => h.line)).toEqual([5]);
    expect(seoLinkText(page, "views/plans.php")).toEqual([]);
    expect(imgWithoutAlt(page, "views/plans.php").map((h) => h.line)).toEqual([7]);
    expect(seoMeta('<!doctype html><html><head><?php echo $t; ?></head><body></body></html>', "public/index.php")).toEqual([]);
    expect(seoMeta("<!doctype html><html><head></head><body></body></html>", "public/index.php")).toHaveLength(2);
  });

  test("a file no enabled check reads, of the main stack, is named as not checked mechanically; nothing is named when a check reads it", () => {
    const files = ["views/a.twig", "views/b.twig", "src/index.php", "src/app.ts", "README.md"];
    expect(skippedFiles(files, ["no-any"])).toEqual([{ check: null, reason: expect.stringContaining("2 .twig files") }]);
    expect(skippedFiles(files, ["file-length"])).toEqual([]);
    expect(skippedFiles(files, [])).toEqual([]);
    const root = makeRepo({ "views/a.twig": "<p>x</p>\n", "views/b.twig": "<p>y</p>\n" });
    const report = checkFiles(root, ["views/a.twig", "views/b.twig"], checksOf(["strict-types"]), DEFAULT_THRESHOLDS);
    expect(report.findings).toEqual([]);
    expect(report.skipped).toHaveLength(1);
  });
});

describe("editing built-in packs, and what a workspace switches off", () => {
  afterEach(() => {
    for (const p of catalog()) if (!p.custom && p.modified) resetBuiltin(p.id);
    for (const p of catalog()) if (p.custom) deleteCustom(p.id);
  });

  const shipped = (id: string) => packById(id) as PackDef;
  const asEdit = (d: PackDef, rules = d.rules) => ({ title: d.title, summary: d.summary, appliesTo: d.appliesTo, rules, skills: d.skills ?? [], checks: d.checks ?? [] });

  test("an edit equal to the shipped pack is not an edit; a real one is modified; reset puts the shipped one back", () => {
    const d = shipped("kiss");
    saveBuiltin("kiss", asEdit(d));
    expect(catalog().find((p) => p.id === "kiss")).toMatchObject({ modified: false, rules: d.rules });

    saveBuiltin("kiss", asEdit(d, [...d.rules, "Keep the edit."]));
    expect(catalog().find((p) => p.id === "kiss")).toMatchObject({ modified: true });
    expect(catalog().find((p) => p.id === "kiss")!.rules).toContain("Keep the edit.");

    resetBuiltin("kiss");
    expect(catalog().find((p) => p.id === "kiss")).toMatchObject({ modified: false, rules: d.rules });
  });

  test("a built-in edit can switch a check off, but cannot give a pack one it never had", () => {
    const d = shipped("strict-types");
    expect(() => saveBuiltin("strict-types", { ...asEdit(d), checks: ["file-length"] })).toThrow(/not a check of Strict types/);
    saveBuiltin("strict-types", { ...asEdit(d), checks: [] });
    const ws = Workspaces.open(makeRepo({ "a.txt": "x\n" })).id;
    setPractices(ws, { enabled: ["strict-types"] });
    expect(activeChecks(ws)).not.toContain("no-any");
  });

  test("a fork is a custom copy with the rules and no checks; the built-in is left alone", () => {
    const d = shipped("strict-types");
    const copy = forkBuiltin("strict-types");
    expect(copy).toMatchObject({ id: "strict-types-copy", title: `${d.title} (copy)`, rules: d.rules });
    expect(catalog().find((p) => p.id === "strict-types")).toMatchObject({ modified: false, custom: false });
    expect(catalog().find((p) => p.id === "strict-types-copy")).toMatchObject({ custom: true, knownChecks: [] });
    expect(forkBuiltin("strict-types").id).toBe("strict-types-copy-2");
  });

  test("the enforce mode is warn unless set; anything else is refused", () => {
    const ws = Workspaces.open(makeRepo({ "a.txt": "x\n" })).id;
    expect(practicesOf(ws).enforce).toBe("warn");
    expect(setPractices(ws, { enforce: "fix" }).enforce).toBe("fix");
    expect(() => setPractices(ws, { enforce: "loud" })).toThrow(/off, warn or fix/);
    expect(practicesOf(ws).enforce).toBe("fix");
  });

  test("a rule or check switched off is off in that workspace only, and a rule the pack does not have is dropped", () => {
    const rule = "No non-null assertion `!`; narrow with a check or handle the missing case.";
    const a = Workspaces.open(makeRepo({ "a.txt": "x\n" })).id;
    const b = Workspaces.open(makeRepo({ "b.txt": "x\n" })).id;
    setPractices(a, { enabled: ["strict-types"], off: { "strict-types": { rules: [rule, "Not a rule of this pack."], checks: ["no-any"] } } });
    setPractices(b, { enabled: ["strict-types"] });

    expect(practicesOf(a).off).toEqual({ "strict-types": { rules: [rule], checks: ["no-any"] } });
    expect(effectivePacks(a)[0]!.rules).not.toContain(rule);
    expect(activeChecks(a)).not.toContain("no-any");
    expect(effectivePacks(b)[0]!.rules).toContain(rule);
    expect(activeChecks(b)).toContain("no-any");

    // A pack switched off keeps its switches, so saving other settings or turning it back on does not lose them.
    setPractices(a, { enabled: [] });
    expect(practicesOf(a).off).toEqual({ "strict-types": { rules: [rule], checks: ["no-any"] } });
    setPractices(a, { enabled: ["strict-types"] });
    expect(activeChecks(a)).not.toContain("no-any");

    expect(() => setPractices(a, { off: { nope: { rules: [] } } })).toThrow(/No practice pack "nope"/);
  });

  test("the findings of a workspace follow its switches: a switched-off check finds nothing", () => {
    const dir = makeRepo({ "src/feature.ts": 'export const pick = JSON.parse("{}") as any;\n' });
    const id = Workspaces.open(dir).id;
    setPractices(id, { enabled: ["strict-types"] });
    expect(practiceFindings(dir, ["src/feature.ts"], dir).map((f) => f.check)).toEqual(["no-any"]);
    setPractices(id, { off: { "strict-types": { rules: [], checks: ["no-any"] } } });
    expect(practiceFindings(dir, ["src/feature.ts"], dir)).toEqual([]);
  });

  test("a recipe may name a custom pack as well as a built-in one, and an unknown pack is refused", () => {
    createCustom({ id: "my-stack", title: "My stack", rules: ["Use the stack we chose."] });
    const recipe = { id: "stack", name: "Stack", generate: ["bunx", "x", "."], starterPrompt: "", practices: ["my-stack", "kiss"] };
    expect(validateRecipe(recipe).practices).toEqual(["my-stack", "kiss"]);
    expect(() => validateRecipe({ ...recipe, practices: ["no-such-pack"] })).toThrow(/practice pack/);
  });
});
