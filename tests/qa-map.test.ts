import { beforeEach, describe, expect, test } from "bun:test";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { UserError } from "../src/util";
import { parseFeatures } from "../src/qa/map";
import { assignAreas, carryIds, mapWritesOf, parseMap, readMap, sectionOf, submitMap, type DraftFeature } from "../src/qa/map";
import type { Area, AreaId, Feature, FeatureId, Job, JobId } from "../src/qa/types";
import { makeDir } from "./helpers";

const FLAT = "# Features\n\nIntro text.\n\n## Checkout\nid: checkout\nwhere: /cart, /checkout\nplans: cart\nA buyer pays.\n\nSecond line.\n\n## Apply a discount code\nid: apply-discount\nparent: checkout\nwhere: /cart\nA buyer enters a code.\n\n## Invite a teammate\nAn owner invites someone.\n\n## Checkout\nid: checkout\n";

const AREAS = [
  "# Features",
  "",
  "# Shop",
  "area: shop",
  "where: /cart, /checkout",
  "Buying things.",
  "",
  "## Checkout",
  "id: checkout",
  "where: /cart/checkout",
  "A buyer pays.",
  "",
  "## Discount code",
  "id: discount",
  "parent: checkout",
  "where: /cart",
  "A buyer enters a code.",
  "",
  "# Team",
  "area: team",
  "where: /team",
  "",
  "## Invite",
  "id: invite",
  "where: /team/invite",
  "An owner invites someone.",
  "",
].join("\n");

describe("parseMap", () => {
  test("a file with no area headings is the flat layout and lists the same features parseFeatures does", () => {
    const m = parseMap(FLAT);
    expect(m.layout).toBe("flat");
    expect(m.areas).toEqual([]);
    const old = parseFeatures(FLAT);
    expect<unknown>(m.features.map(({ area, ...f }) => f)).toEqual(old.features);
    expect(m.features.every((f) => f.area === null)).toBe(true);
    expect(m.problem).toBe(old.problem);
    expect(old.problem).toContain('Two features have the id "checkout"');
  });

  test("parseFeatures output carries no area key", () => {
    expect<unknown>(Object.keys(parseFeatures(FLAT).features[0]!).sort()).toEqual(["id", "parent", "summary", "title", "where"]);
  });

  test("an area heading followed by an area: line starts an area; its features belong to it until the next one", () => {
    const m = parseMap(AREAS);
    expect(m.layout).toBe("areas");
    expect(m.problem).toBeNull();
    expect<unknown>(m.areas).toEqual([
      { id: "shop", title: "Shop", where: ["/cart", "/checkout"], summary: "Buying things." },
      { id: "team", title: "Team", where: ["/team"], summary: "" },
    ]);
    expect<unknown>(m.features.map((f) => [f.id, f.area, f.parent])).toEqual([["checkout", "shop", null], ["discount", "shop", "checkout"], ["invite", "team", null]]);
    expect(m.features[0]!.summary).toBe("A buyer pays.");
  });

  test("the area text still lists every ## feature to the old parser, and a summary does not swallow the next area", () => {
    const old = parseFeatures(AREAS);
    expect<unknown>(old.features.map((f) => f.id)).toEqual(["checkout", "discount", "invite"]);
    expect(old.features[1]!.summary).toBe("A buyer enters a code.");
  });

  test("a # heading without an area: line is plain text, not an area", () => {
    const m = parseMap("# Features\n\n# Notes\nsome words\n\n## A\nid: a\n");
    expect(m.layout).toBe("flat");
    expect<unknown>(m.features.map((f) => f.id)).toEqual(["a"]);
  });

  test("a bad or repeated area id is a problem, and features above the first area are flagged", () => {
    const m = parseMap("## Loose\nid: loose\n\n# One\narea: Not Valid\n\n# Two\narea: two\n\n# Again\narea: two\n");
    expect<unknown>(m.areas.map((a) => a.id)).toEqual(["one", "two", "two-2"]);
    expect(m.problem).toContain('area id "Not Valid"');
    expect(m.problem).toContain('Two areas have the id "two"');
    expect(m.problem).toContain("before the first area");
  });
});

describe("sectionOf", () => {
  test("the whole map, one area's section and the area list are text a job can edit and submit back", () => {
    const m = { ...parseMap(AREAS), exists: true, updatedAt: 1 };
    const shop = sectionOf(m, "area:shop");
    expect(shop.startsWith("# Shop\narea: shop\nwhere: /cart, /checkout\nBuying things.\n\n## Checkout\nid: checkout\n")).toBe(true);
    expect(shop).not.toContain("Invite");
    expect<unknown>(parseMap(shop).features.map((f) => f.id)).toEqual(["checkout", "discount"]);
    expect(sectionOf(m, "area:ghost")).toBe("");
    expect(sectionOf(m, "areas")).toContain("# Team\narea: team");
    expect(sectionOf(m, "areas")).not.toContain("## ");
    const whole = sectionOf(m, "map");
    expect<unknown>(parseMap(whole).features.map((f) => f.id)).toEqual(["checkout", "discount", "invite"]);
  });
});

const fid = (s: string) => s as FeatureId;
const aid = (s: string) => s as AreaId;
const old = (id: string, title: string, where: string[] = [], parent: string | null = null): Feature => ({ id: fid(id), title, where, parent: parent === null ? null : fid(parent), summary: "" });
const draft = (title: string, over: Partial<DraftFeature> = {}): DraftFeature => ({ id: null, was: null, title, where: [], parent: null, summary: "", ...over });
const owners = (m: Record<string, string | null>) => new Map(Object.entries(m).map(([k, v]) => [fid(k), v === null ? null : aid(v)]));

describe("carryIds", () => {
  const before = [old("checkout", "Checkout", ["/cart/checkout"]), old("refunds", "Refunds", ["/refunds"]), old("invite", "Invite", ["/team"])];
  const own = owners({ checkout: "shop", refunds: "shop", invite: "team" });

  test("a retitled entry keeps its old id when it names it with was:, whatever id: it wrote", () => {
    const r = carryIds(before, [draft("Pay for the cart", { was: "checkout", id: "pay" }), draft("Refunds")], own, aid("shop"));
    expect(r.problems).toEqual([]);
    expect<unknown>(r.features.map((f) => [f.id, f.title, f.area])).toEqual([["checkout", "Pay for the cart", "shop"], ["refunds", "Refunds", "shop"]]);
  });

  test("an entry with the same title (ignoring case) or the same where and parent gets its id back", () => {
    const r = carryIds(before, [draft("REFUNDS", { id: "other" }), draft("Pay now", { where: ["/cart/checkout"] })], own, aid("shop"));
    expect(r.problems).toEqual([]);
    expect<unknown>(r.features.map((f) => f.id)).toEqual(["refunds", "checkout"]);
  });

  test("an ambiguous where match is not guessed", () => {
    const twins = [old("a", "A", ["/x"]), old("b", "B", ["/x"])];
    const r = carryIds(twins, [draft("C", { where: ["/x"] }), draft("D", { where: ["/x"] })], owners({ a: "s", b: "s" }), aid("s"));
    expect(r.problems.length).toBe(2);
    expect<unknown>(r.features.map((f) => f.id)).toEqual(["c", "d"]);
  });

  test("a new entry takes its id: when free, else a slug of its title; a clash with another area is prefixed, then numbered", () => {
    const own2 = owners({ checkout: "shop", invite: "team", plans: "team" });
    const base = [old("checkout", "Checkout"), old("invite", "Invite"), old("plans", "Plans")];
    const r = carryIds(base, [draft("Checkout"), draft("Brand new", { id: "fresh" }), draft("Invite people", { id: "invite" }), draft("Plans"), draft("Plans")], own2, aid("shop"));
    expect<unknown>(r.features.map((f) => f.id)).toEqual(["checkout", "fresh", "shop-invite", "shop-plans", "shop-plans-2"]);
    const flat = carryIds([], [draft("Same"), draft("Same")], new Map(), null);
    expect<unknown>(flat.features.map((f) => f.id)).toEqual(["same", "same-2"]);
  });

  test("an old id missing from the submission is a problem that names the fix; drop: accepts it and reports it", () => {
    const rejected = carryIds(before, [draft("Checkout")], own, aid("shop"));
    expect(rejected.problems.join(" ")).toContain("'refunds'");
    expect(rejected.problems.join(" ")).toContain("drop: refunds");
    expect(rejected.problems.join(" ")).toContain("was: refunds");
    const accepted = carryIds(before, [draft("Checkout")], own, aid("shop"), ["refunds", "ghost"]);
    expect(accepted.problems).toEqual([]);
    expect<unknown>(accepted.dropped).toEqual(["refunds"]);
    const both = carryIds(before, [draft("Checkout"), draft("Refunds")], own, aid("shop"), ["refunds"]);
    expect(both.problems.join(" ")).toContain("'refunds'");
  });

  test("ids of another area are not this submission's business", () => {
    const r = carryIds(before, [draft("Checkout"), draft("Refunds")], own, aid("shop"));
    expect(r.problems).toEqual([]);
    expect(r.dropped).toEqual([]);
  });

  test("a child's parent is resolved after ids are carried, by any id the author used for it", () => {
    const r = carryIds(before, [draft("Pay for the cart", { was: "checkout", id: "pay" }), draft("Coupons", { parent: "pay", where: ["/c"] }), draft("Tips", { parent: "checkout" }), draft("Refunds")], own, aid("shop"));
    expect(r.problems).toEqual([]);
    expect<unknown>(r.features.map((f) => [f.id, f.parent])).toEqual([["checkout", null], ["coupons", "checkout"], ["tips", "checkout"], ["refunds", null]]);
  });

  test("a parent that is not in the submission, is itself a child, or is the entry itself is a problem", () => {
    const r = carryIds([], [draft("A"), draft("B", { parent: "a" }), draft("C", { parent: "b" }), draft("D", { parent: "ghost" }), draft("E", { parent: "e" })], new Map(), null);
    const text = r.problems.join(" ");
    expect(r.problems.length).toBe(3);
    expect(text).toContain('"C"');
    expect(text).toContain('"D"');
    expect(text).toContain('"E"');
  });
});

describe("assignAreas", () => {
  const area = (id: string, ...where: string[]): Area => ({ id: aid(id), title: id, where, summary: "" });
  const areas = [area("shop", "/cart", "/checkout"), area("deep", "/cart/gift"), area("team", "/team"), area("a", "/dup"), area("b", "/dup")];

  test("the longest area path that prefixes a feature's path wins", () => {
    const placed = assignAreas([old("c", "C", ["/cart/checkout"]), old("g", "G", ["/cart/gift/wrap"]), old("t", "T", ["/team"]), old("cart", "Cart", ["/cart"])], areas);
    expect<unknown>(placed.map((f) => f.area)).toEqual(["shop", "deep", "team", "shop"]);
  });

  test("a tie, a path that matches nothing, an entry not starting with /, and no where all go to unsorted", () => {
    const placed = assignAreas([old("t", "T", ["/dup/x"]), old("n", "N", ["/nowhere"]), old("r", "R", ["cart"]), old("e", "E")], areas);
    expect<unknown>(placed.map((f) => f.area)).toEqual(["unsorted", "unsorted", "unsorted", "unsorted"]);
  });

  test("a /cartoon path is not under /cart, and a child follows its parent", () => {
    const placed = assignAreas([old("p", "P", ["/team"]), old("k", "K", ["/cart"], "p"), old("x", "X", ["/cartoon"])], areas);
    expect<unknown>(placed.map((f) => [f.id, f.area])).toEqual([["p", "team"], ["k", "team"], ["x", "unsorted"]]);
  });

  test("ids never change", () => {
    const input = [old("c", "C", ["/cart"]), old("z", "Z")];
    expect<unknown>(assignAreas(input, areas).map((f) => f.id)).toEqual(["c", "z"]);
  });
});

describe("submitMap", () => {
  let root: string;
  let n = 0;
  const file = () => path.join(root, "lab/features.md");
  const put = (text: string) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), text);
  };
  const read = () => fs.readFileSync(file(), "utf-8");
  const job = (unit: string, stage: Job["stage"] = "map"): Job => ({ id: `qaj_map${++n}` as JobId, pipeline: "qap_x" as Job["pipeline"], root, stage, units: [unit] as unknown as Job["units"], session: null, error: null, sigs: {}, nudgedTurns: null, problem: null, failed: null, startedAt: 1, settledAt: null });
  const section = (text: string, head: string) => {
    const start = text.indexOf(head);
    const next = text.indexOf("\n# ", start + 1);
    return text.slice(start, next < 0 ? undefined : next + 1);
  };
  const lines = (...l: string[]) => l.join("\n") + "\n";

  beforeEach(() => {
    root = makeDir();
    db().exec("DELETE FROM qa_map_writes");
  });

  test("an area job replaces only its own section: the other sections and the preamble stay byte for byte", () => {
    put(AREAS);
    const teamBefore = section(read(), "# Team");
    const j = job("area:shop");
    const reply = submitMap(
      root,
      j,
      lines("## Pay for the cart", "was: checkout", "id: pay", "where: /cart/checkout", "A buyer pays.", "", "## Discount code", "id: discount", "parent: pay", "where: /cart", "A buyer enters a code.", "", "## Gift wrap", "where: /cart/gift", "Wrap it."),
    ).text;
    expect(reply).toBe("Saved: 3 features (1 new: gift-wrap). Kept ids for 1 retitled.");
    const after = read();
    expect(section(after, "# Team")).toBe(teamBefore);
    expect(after.startsWith("# Features\n\n# Shop\narea: shop\nwhere: /cart, /checkout\nBuying things.\n\n## Pay for the cart\nid: checkout\n")).toBe(true);
    expect(after).not.toContain("was:");
    const m = readMap(root);
    expect<unknown>(m.features.map((f) => [f.id, f.area, f.parent])).toEqual([["checkout", "shop", null], ["discount", "shop", "checkout"], ["gift-wrap", "shop", null], ["invite", "team", null]]);
    expect(fs.readdirSync(path.dirname(file()))).toEqual(["features.md"]);
    const [w] = mapWritesOf(j.id);
    expect<unknown>(w).toMatchObject({ job: j.id, unit: "area:shop", changed: true, dropped: [], sig: crypto.createHash("sha1").update(after).digest("hex") });
  });

  test("submitting the text a job was given changes nothing, and that is a success recorded as changed: false", () => {
    put(AREAS);
    const given = sectionOf(readMap(root), "area:shop");
    submitMap(root, job("area:shop"), given);
    const settled = read();
    const j = job("area:shop");
    expect(submitMap(root, j, given).text).toBe("No changes.");
    expect(read()).toBe(settled);
    const rows = mapWritesOf(j.id);
    expect<unknown>(rows.map((w) => w.changed)).toEqual([false]);
    expect(rows[0]!.sig).toBe(crypto.createHash("sha1").update(settled).digest("hex"));
  });

  test("a section spliced into a CRLF file is written with CRLF throughout, and resubmitting it changes nothing", () => {
    put(AREAS.replace(/\n/g, "\r\n"));
    const given = lines("## Pay for the cart", "was: checkout", "id: pay", "where: /cart/checkout", "A buyer pays.", "", "## Discount code", "id: discount", "parent: pay", "where: /cart", "A buyer enters a code.", "", "## Gift wrap", "where: /cart/gift", "Wrap it.");
    expect(submitMap(root, job("area:shop"), given).text).toContain("Saved: 3 features");
    const after = read();
    expect(after).toContain("Gift wrap");
    expect(after.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const j = job("area:shop");
    expect(submitMap(root, j, sectionOf(readMap(root), "area:shop")).text).toBe("No changes.");
    expect(read()).toBe(after);
    expect(mapWritesOf(j.id)[0]).toMatchObject({ changed: false, sig: crypto.createHash("sha1").update(after).digest("hex") });
  });

  test("a new features.md is written with LF", () => {
    submitMap(root, job("map"), lines("## Checkout", "where: /cart", "A buyer pays."));
    expect(read()).not.toContain("\r");
  });

  test("a missing id rejects the whole submission with the fix named, and nothing is written or recorded", () => {
    put(AREAS);
    const before = read();
    const j = job("area:shop");
    const text = lines("## Checkout", "id: checkout", "where: /cart/checkout");
    let err: unknown;
    try {
      submitMap(root, j, text);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toContain("'discount'");
    expect((err as Error).message).toContain("drop: discount");
    expect(read()).toBe(before);
    expect(mapWritesOf(j.id)).toEqual([]);
    expect(submitMap(root, j, `${text}\ndrop: discount\n`).text).toBe("Saved: 1 feature. Dropped: discount.");
    expect<unknown>(readMap(root).features.map((f) => f.id)).toEqual(["checkout", "invite"]);
    expect<unknown>(mapWritesOf(j.id).map((w) => w.dropped)).toEqual([["discount"]]);
  });

  test("a job cannot pick its area: another area's heading, an unknown area and a non-map job are refused", () => {
    put(AREAS);
    const before = read();
    expect(() => submitMap(root, job("area:shop"), lines("# Team", "area: team", "", "## Invite", "id: invite"))).toThrow("do not write another area heading");
    expect(() => submitMap(root, job("area:ghost"), "## A\n")).toThrow('There is no area "ghost"');
    expect(() => submitMap(root, job("fix-it"), "## A\n")).toThrow("not a map unit");
    expect(() => submitMap(root, job("map", "plan"), "## A\n")).toThrow("QA map job");
    expect(read()).toBe(before);
  });

  test("the flat map is written whole with an id on every entry, keeps ids across retitles, and refuses to flatten areas", () => {
    expect(submitMap(root, job("map"), lines("# Features", "", "## Checkout", "Pays.", "", "## Invite", "id: invite", "where: /team")).text).toBe("Saved: 2 features (2 new: checkout, invite).");
    expect(read()).toBe(lines("# Features", "", "## Checkout", "id: checkout", "Pays.", "", "## Invite", "id: invite", "where: /team"));
    expect(submitMap(root, job("map"), lines("## Buying things", "was: checkout", "Pays.", "", "## Invite", "where: /team")).text).toBe("Saved: 2 features. Kept ids for 1 retitled.");
    expect<unknown>(readMap(root).features.map((f) => f.id)).toEqual(["checkout", "invite"]);
    put(AREAS);
    expect(() => submitMap(root, job("map"), "## A\n")).toThrow("organized in areas");
    expect(() => submitMap(root, job("map"), lines("# X", "area: x", "## A"))).toThrow("area headings");
  });

  test("the area survey writes the areas, places the existing features by their pages and sends the rest to unsorted", () => {
    put(lines("# Features", "", "## Checkout", "id: checkout", "where: /cart/checkout", "", "## Invite", "id: invite", "where: /team/invite", "", "## Oddity", "id: oddity", "where: /weird"));
    const reply = submitMap(root, job("areas"), lines("# Shop", "area: shop", "where: /cart", "Buying.", "", "# Team", "area: team", "where: /team")).text;
    expect(reply).toBe("Saved: 3 areas. 3 features: 2 placed, 1 in unsorted.");
    const m = readMap(root);
    expect(m.layout).toBe("areas");
    expect<unknown>(m.areas.map((a) => a.id)).toEqual(["shop", "team", "unsorted"]);
    expect<unknown>(m.features.map((f) => [f.id, f.area])).toEqual([["checkout", "shop"], ["invite", "team"], ["oddity", "unsorted"]]);
    expect(() => submitMap(root, job("areas"), lines("# A", "area: a", "", "## Feature"))).toThrow("areas only");
    expect(submitMap(root, job("areas"), sectionOf(readMap(root), "areas")).text).toBe("No changes.");
  });
});
