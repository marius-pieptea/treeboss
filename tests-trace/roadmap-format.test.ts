import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START roadmap-format\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END roadmap-format\n"); });
import { describe, expect, test } from "bun:test";
import { addItem, addLane, deleteItem, deleteLane, joinLines, moveItem, parseRoadmap, renameLane, roadmapTemplate, splitFields, splitLines, updateItem } from "../src/roadmap/format";

const SAMPLE = `# Acme roadmap

Some prose that must survive.

## Now

- [ ] Ship chat {#r1} (spec: specs/003-chat) (docs: docs/chat.md) (tag: core, ux) (target: 2026-Q4)
  Description line one.
  Description line two.
- [x] Fix login {#r2} (tag: bug)

## Next

Prose inside a lane.

- [ ] Billing {#r3} (target: 2026-11)
- [ ] No id item
  with a description

## Later
`;

const FIXTURES: Record<string, string> = {
  sample: SAMPLE,
  crlf: SAMPLE.replace(/\n/g, "\r\n"),
  noFinalNewline: SAMPLE.replace(/\n$/, ""),
  mixedEol: "## Now\r\n- [ ] a {#r1}\n- [ ] b {#r2}\r\n\n## Next\n",
  trailingSpaces: "## Now  \n- [ ] a {#r1}   \n  desc   \n\n## Next\n",
  tabs: "## Now\n\t- [ ] tabbed\n- [ ] x\n\tdesc under x\n",
  starMarkers: "## Now\n* [ ] star item\n+ [x] plus item\n",
  empty: "",
  onlyProse: "just some text\nwith no lanes\n",
  noItems: "## A\n\n## B\n\n## C\n",
  fenced: "## Now\n\n```md\n## Fake lane\n- [ ] fake item\n```\n\n- [ ] real item\n",
  commented: "# T\n<!--\n## Hidden\n- [ ] hidden {#r9}\n-->\n## Now\n- [ ] real\n",
  nested: "## Now\n- [ ] parent\n  - [ ] child checkbox is description\n    deeper\n- [ ] sibling\n",
  duplicates: "## Now\n- [ ] Same\n- [ ] Same\n- [ ] Same {#r1}\n",
  h3: "## Now\n### Sub heading\n- [ ] a\n",
  onlyHeading: "## Now",
};

describe("round trip", () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    test(`${name}: split/join and parse keep every byte`, () => {
      expect(joinLines(splitLines(text))).toBe(text);
      expect(joinLines(parseRoadmap(text).lines)).toBe(text);
    });
  }
  test("the generated template parses to three empty lanes and ignores the example in its own docs", () => {
    const p = parseRoadmap(roadmapTemplate("Demo"));
    expect(p.lanes.map((l) => l.name)).toEqual(["Now", "Next", "Later"]);
    expect(p.lanes.every((l) => l.items.length === 0)).toBe(true);
    expect(p.nextId).toBe(1); // {#r1} in the comment does not count
  });
});

describe("parse", () => {
  const p = parseRoadmap(SAMPLE);
  test("lanes, items, fields", () => {
    expect(p.lanes.map((l) => [l.name, l.items.length])).toEqual([["Now", 2], ["Next", 2], ["Later", 0]]);
    const [chat, login] = p.lanes[0]!.items;
    expect(chat).toMatchObject({ id: "r1", key: "r1", title: "Ship chat", done: false, spec: "specs/003-chat", docs: "docs/chat.md", tags: ["core", "ux"], target: "2026-Q4", description: "Description line one.\nDescription line two." });
    expect(login).toMatchObject({ id: "r2", done: true, tags: ["bug"] });
  });
  test("an item without an id gets a derived key, and equals are told apart", () => {
    const noId = p.lanes[1]!.items[1]!;
    expect(noId.id).toBeNull();
    expect(noId.key).toMatch(/^t-/);
    expect(noId.description).toBe("with a description");
    const d = parseRoadmap(FIXTURES.duplicates!).lanes[0]!.items;
    expect(new Set(d.map((i) => i.key)).size).toBe(3);
  });
  test("next id continues from the highest used", () => {
    expect(p.nextId).toBe(4);
  });
  test("fenced and commented text is not parsed", () => {
    expect(parseRoadmap(FIXTURES.fenced!).lanes.map((l) => [l.name, l.items.map((i) => i.title)])).toEqual([["Now", ["real item"]]]);
    expect(parseRoadmap(FIXTURES.commented!).lanes.map((l) => [l.name, l.items.map((i) => i.title)])).toEqual([["Now", ["real"]]]);
  });
  test("nested checkboxes are part of the description", () => {
    const items = parseRoadmap(FIXTURES.nested!).lanes[0]!.items;
    expect(items.map((i) => i.title)).toEqual(["parent", "sibling"]);
    expect(items[0]!.description).toContain("child checkbox");
  });
  test("other markers, tabs and H3s", () => {
    expect(parseRoadmap(FIXTURES.starMarkers!).lanes[0]!.items.map((i) => [i.marker, i.done])).toEqual([["*", false], ["+", true]]);
    // A tab is four columns: an item indented that far is not a top-level item (it is code, in Markdown).
    const tabs = parseRoadmap(FIXTURES.tabs!).lanes[0]!.items;
    expect(tabs.map((i) => i.title)).toEqual(["x"]);
    expect(tabs[0]!.description).toBe("desc under x");
    expect(parseRoadmap(FIXTURES.h3!).lanes[0]!.items).toHaveLength(1);
  });
  test("unknown parentheses stay in the title; fields tolerate spacing and case", () => {
    expect(splitFields("Do it (maybe) {#r5} ( SPEC : specs/a ) (Tags: x,  y ) (target:  Q1 )")).toEqual({ title: "Do it (maybe)", id: "r5", spec: "specs/a", docs: null, tags: ["x", "y"], target: "Q1" });
    expect(splitFields("{#r1} (tag: a) (tag: a, b)").tags).toEqual(["a", "b"]);
    expect(splitFields("(spec: x)").title).toBe("(untitled)");
  });
});

/** Lines of `text` as an array of strings with their endings, for diffing what an edit touched. */
const lines = (t: string): string[] => splitLines(t).map((l) => l.text + l.eol);

/** Everything outside the changed region is identical: a common prefix and suffix account for all but the edit. */
function onlyChanged(before: string, after: string, maxChanged: number): void {
  const a = lines(before);
  const b = lines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  expect(Math.max(a.length - pre - suf, b.length - pre - suf)).toBeLessThanOrEqual(maxChanged);
}

describe("edits touch only their own lines", () => {
  test("toggling done flips one character", () => {
    const r = updateItem(SAMPLE, "r1", { done: true });
    expect(r.text).toBe(SAMPLE.replace("- [ ] Ship chat", "- [x] Ship chat"));
  });
  test("editing an item without an id assigns the next id, and nothing else changes", () => {
    const key = parseRoadmap(SAMPLE).lanes[1]!.items[1]!.key;
    const r = updateItem(SAMPLE, key, { done: true });
    expect(r.id).toBe("r4");
    expect(r.text).toBe(SAMPLE.replace("- [ ] No id item", "- [x] No id item {#r4}"));
    expect(updateItem(r.text, "r4", { done: false }).text).toBe(r.text.replace("[x] No id", "[ ] No id"));
  });
  test("a no-op edit of an item that has an id changes nothing", () => {
    expect(updateItem(SAMPLE, "r1", {}).text).toBe(SAMPLE);
    expect(updateItem(SAMPLE, "r1", { title: "Ship chat", tags: ["core", "ux"] }).text).toBe(SAMPLE);
  });
  test("retitle, retag, clear a field", () => {
    const r = updateItem(SAMPLE, "r1", { title: "Ship chat v2", tags: ["core"], target: null, docs: null });
    expect(r.text).toContain("- [ ] Ship chat v2 {#r1} (spec: specs/003-chat) (tag: core)\n  Description line one.");
    onlyChanged(SAMPLE, r.text, 1);
  });
  test("editing the description replaces only its lines", () => {
    const r = updateItem(SAMPLE, "r1", { description: "New text\n\nsecond paragraph" });
    expect(r.text).toContain("{#r1} (spec: specs/003-chat) (docs: docs/chat.md) (tag: core, ux) (target: 2026-Q4)\n  New text\n\n  second paragraph\n- [x] Fix login");
    expect(updateItem(r.text, "r1", { description: "" }).text).toBe(SAMPLE.replace("  Description line one.\n  Description line two.\n", ""));
  });
  test("adding to a lane with items goes after the last one", () => {
    const r = addItem(SAMPLE, { lane: "now", title: "New thing", tags: ["x"], description: "why" });
    expect(r.id).toBe("r4");
    expect(r.text).toContain("- [x] Fix login {#r2} (tag: bug)\n- [ ] New thing {#r4} (tag: x)\n  why\n\n## Next");
    onlyChanged(SAMPLE, r.text, 2);
  });
  test("adding at an index, and to an empty lane (blank line above, kept below)", () => {
    const top = addItem(SAMPLE, { lane: "Now", title: "Top", index: 0 });
    expect(top.text).toContain("Some prose that must survive.\n\n## Now\n\n- [ ] Top {#r4}\n- [ ] Ship chat");
    const empty = addItem(SAMPLE, { lane: "Later", title: "Someday" });
    expect(empty.text.endsWith("## Later\n\n- [ ] Someday {#r4}\n")).toBe(true);
    const between = addItem(FIXTURES.noItems!, { lane: "B", title: "x" });
    expect(between.text).toBe("## A\n\n## B\n\n- [ ] x {#r1}\n\n## C\n");
  });
  test("a file without a final newline stays that way", () => {
    for (const lane of ["Now", "Later"]) {
      const bare = SAMPLE.replace(/\n$/, "");
      const r = addItem(bare, { lane, title: "z" });
      expect(r.text.endsWith("\n")).toBe(false);
      expect(parseRoadmap(r.text).lanes.find((l) => l.name === lane)!.items.some((i) => i.title === "z")).toBe(true);
    }
    expect(addItem("## Now", { lane: "Now", title: "z" }).text).toBe("## Now\n\n- [ ] z {#r1}");
  });
  test("CRLF files stay CRLF", () => {
    const r = addItem(FIXTURES.crlf!, { lane: "Now", title: "z", description: "d" });
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\r");
  });
  test("moving between lanes and reordering inside one", () => {
    const m = moveItem(SAMPLE, "r1", "Next", 0);
    const p = parseRoadmap(m.text);
    expect(p.lanes[0]!.items.map((i) => i.id)).toEqual(["r2"]);
    expect(p.lanes[1]!.items.map((i) => i.id ?? "·")).toEqual(["r1", "r3", "·"]);
    expect(p.lanes[1]!.items[0]!.description).toBe("Description line one.\nDescription line two.");
    const re = moveItem(SAMPLE, "r2", "Now", 0);
    expect(parseRoadmap(re.text).lanes[0]!.items.map((i) => i.id)).toEqual(["r2", "r1"]);
    expect(moveItem(SAMPLE, "r1", "Now", 5).text).toBe(SAMPLE.replace(/- \[ \] Ship chat[^\n]*\n  Description line one\.\n  Description line two\.\n- \[x\] Fix login[^\n]*\n/, (m) => m.split("- [x] Fix login")[1] ? `- [x] Fix login {#r2} (tag: bug)\n${m.split("- [x] Fix login {#r2} (tag: bug)\n")[0]}` : m));
  });
  test("moving an item without an id gives it one", () => {
    const key = parseRoadmap(SAMPLE).lanes[1]!.items[1]!.key;
    const m = moveItem(SAMPLE, key, "Later");
    expect(m.id).toBe("r4");
    expect(parseRoadmap(m.text).lanes[2]!.items.map((i) => [i.id, i.description])).toEqual([["r4", "with a description"]]);
  });
  test("the last item of a file with no final newline can move up and down", () => {
    const bare = "## A\n- [ ] one {#r1}\n## B\n- [ ] two {#r2}";
    const up = moveItem(bare, "r2", "A");
    expect(up.text).toBe("## A\n- [ ] one {#r1}\n- [ ] two {#r2}\n## B");
    const back = moveItem(up.text, "r2", "B");
    expect(parseRoadmap(back.text).lanes[1]!.items.map((i) => i.id)).toEqual(["r2"]);
    expect(back.text.endsWith("\n")).toBe(false);
  });
  test("delete removes the item and its description", () => {
    const r = deleteItem(SAMPLE, "r1");
    expect(r.text).toBe(SAMPLE.replace(/- \[ \] Ship chat[^\n]*\n  Description line one\.\n  Description line two\.\n/, ""));
    expect(deleteItem("## A\n- [ ] x {#r1}", "r1").text).toBe("## A");
  });
  test("lanes: add, rename, delete only when empty", () => {
    expect(addLane(SAMPLE, "Parked").text).toBe(`${SAMPLE}\n## Parked\n`);
    expect(addLane("## A\n- [ ] x", "B").text).toBe("## A\n- [ ] x\n\n## B");
    expect(addLane("", "A").text).toBe("## A\n");
    expect(renameLane(SAMPLE, "Next", "Soon").text).toBe(SAMPLE.replace("## Next", "## Soon"));
    expect(() => deleteLane(SAMPLE, "Now")).toThrow(/still has 2 items/);
    expect(deleteLane(SAMPLE, "Later").text).toBe(SAMPLE.replace("\n## Later\n", ""));
    expect(() => addLane(SAMPLE, "now")).toThrow(/already/);
    expect(() => moveItem(SAMPLE, "r1", "Nowhere")).toThrow(/No lane/);
    expect(() => updateItem(SAMPLE, "zzz", {})).toThrow(/No roadmap item/);
    expect(() => addItem(SAMPLE, { lane: "Now", title: "  " })).toThrow(/title/);
  });
  test("values cannot break out of their parentheses or the line", () => {
    const r = addItem(SAMPLE, { lane: "Now", title: "a\nb {#r99}", spec: "x) (tag: evil", tags: ["a(b)"] });
    const it = parseRoadmap(r.text).lanes[0]!.items.at(-1)!;
    expect(it.id).toBe("r4");
    expect(it.title).toBe("a b { #r99}");
    expect(it.tags).toEqual(["ab"]);
    expect(it.spec).toBe("x tag: evil");
  });
});

/** A small deterministic generator, so a failure names the seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("random edit sequences", () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    if (!/^## /m.test(text)) continue;
    test(`${name}: every edit leaves the rest of the file untouched and the file parseable`, () => {
      for (let seed = 1; seed <= 25; seed++) {
        const rand = rng(seed * 7919);
        let cur = text;
        for (let step = 0; step < 12; step++) {
          const p = parseRoadmap(cur);
          const items = p.lanes.flatMap((l) => l.items);
          const lane = p.lanes[Math.floor(rand() * p.lanes.length)]!;
          const pick = items[Math.floor(rand() * items.length)];
          const op = Math.floor(rand() * 5);
          const before = cur;
          const ctx = `${name} seed ${seed} step ${step} op ${op}`;
          if (op === 0) cur = addItem(cur, { lane: lane.name, title: `item ${seed}-${step}`, index: rand() < 0.5 ? 0 : null }).text;
          else if (op === 1 && pick) cur = updateItem(cur, pick.key, { done: !pick.done }).text;
          else if (op === 2 && pick) cur = moveItem(cur, pick.key, lane.name, Math.floor(rand() * 3)).text;
          else if (op === 3 && pick) cur = deleteItem(cur, pick.key).text;
          else if (op === 4 && pick) cur = updateItem(cur, pick.key, { title: `renamed ${step}`, tags: ["t"] }).text;
          const after = parseRoadmap(cur);
          // Nothing is lost or invented: the multiset of item titles changes only as the op says.
          const titles = (t: string) => parseRoadmap(t).lanes.flatMap((l) => l.items.map((i) => i.title)).sort();
          const b = titles(before);
          const a = titles(cur);
          if (op === 0) expect(a.length, ctx).toBe(b.length + 1);
          else if (op === 3 && pick) expect(a.length, ctx).toBe(b.length - 1);
          else if (op === 2 || op === 1) expect(a, ctx).toEqual(b);
          // Lane headings and the prose outside items are unchanged by item edits.
          expect(after.lanes.map((l) => l.name), ctx).toEqual(parseRoadmap(before).lanes.map((l) => l.name));
          // Ids stay unique.
          const ids = after.lanes.flatMap((l) => l.items.map((i) => i.id).filter(Boolean));
          expect(new Set(ids).size, ctx).toBe(ids.length);
          expect(joinLines(splitLines(cur)), ctx).toBe(cur);
        }
      }
    });
  }
});
