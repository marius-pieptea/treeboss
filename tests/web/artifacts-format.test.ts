import { describe, expect, test } from "bun:test";
import {
  boundsOf,
  fitView,
  visibleBoards,
  zoomAt,
} from "../../web/src/features/artifacts/canvas-math";
import type { Artifact } from "../../web/src/features/artifacts/data";
import {
  artifactBadges,
  capabilityFileUrl,
  countByIntent,
  documentsTabLabel,
  extractArtifactBoards,
  extractCanvasNotes,
  filterArtifacts,
  formatAskAgentDraft,
  formatFileSize,
  groupArtifacts,
  isSharedArtifact,
  matchesSearch,
} from "../../web/src/features/artifacts/format";

const NOW = new Date("2026-11-26T15:00:00").getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function makeArtifact(overrides: Partial<Artifact> & { id: string }): Artifact {
  return {
    url: `https://claude.ai/artifact/${overrides.id}`,
    title: `Artifact ${overrides.id}`,
    intent: "document",
    owner: "mine",
    source: "created",
    sessionId: "sess-1",
    sessionTitle: "Session One",
    createdAt: NOW - HOUR,
    updatedAt: null,
    lastReadAt: NOW - HOUR,
    htmlPath: `/tmp/${overrides.id}/index.html`,
    summary: null,
    error: null,
    errorText: null,
    typeName: null,
    contentKind: null,
    contentPath: null,
    ...overrides,
  };
}

describe("artifacts format", () => {
  test("groups by session sorted by newest item, handles untitled and pasted, collapses after 5", () => {
    const items: Artifact[] = [
      makeArtifact({ id: "a1", sessionId: "abcdef123456", sessionTitle: null, createdAt: NOW - 1 * HOUR }),
      makeArtifact({ id: "a2", sessionId: null, sessionTitle: null, source: "pasted", createdAt: NOW - 2 * HOUR }),
      makeArtifact({ id: "a3", sessionId: "s2", sessionTitle: "Second", createdAt: NOW - 3 * HOUR }),
      makeArtifact({ id: "a4", sessionId: "s3", sessionTitle: "Third", createdAt: NOW - 4 * HOUR }),
      makeArtifact({ id: "a5", sessionId: "s4", sessionTitle: "Fourth", createdAt: NOW - 5 * HOUR }),
      makeArtifact({ id: "a6", sessionId: "s5", sessionTitle: "Fifth", createdAt: NOW - 6 * HOUR }),
      makeArtifact({ id: "a7", sessionId: "s6", sessionTitle: "Sixth", createdAt: NOW - 7 * HOUR }),
      makeArtifact({ id: "a8", sessionId: "s4", sessionTitle: "Fourth", createdAt: NOW - 10 * HOUR }),
    ];

    const groups = groupArtifacts(items, "session", NOW);
    expect(groups.map((g) => g.label)).toEqual([
      "Session abcdef",
      "Pasted links",
      "Second",
      "Third",
      "Fourth",
      "Fifth",
      "Sixth",
    ]);
    expect(groups.slice(0, 5).every((g) => !g.collapsedByDefault)).toBe(true);
    expect(groups.slice(5).every((g) => g.collapsedByDefault)).toBe(true);
    expect(groups[4].items.map((i) => i.id)).toEqual(["a5", "a8"]);
  });

  test("groups by date into Today, Yesterday, Earlier and omits empty buckets", () => {
    const items: Artifact[] = [
      makeArtifact({ id: "t1", createdAt: NOW - 2 * HOUR }),
      makeArtifact({ id: "y1", createdAt: NOW - DAY }),
      makeArtifact({ id: "e1", createdAt: NOW - 5 * DAY }),
    ];

    const groups = groupArtifacts(items, "date", NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(groups.every((g) => !g.collapsedByDefault)).toBe(true);

    const onlyToday = groupArtifacts([items[0]], "date", NOW);
    expect(onlyToday.map((g) => g.label)).toEqual(["Today"]);
  });

  test("matchesSearch searches title, session title, and url case-insensitively", () => {
    const item = makeArtifact({
      id: "9c41e7d2",
      title: "Shelf rail · three options",
      sessionTitle: "agent-pane-redesign",
      url: "https://claude.ai/artifact/9c41e7d2",
    });

    expect(matchesSearch(item, "")).toBe(true);
    expect(matchesSearch(item, "  SHELF  ")).toBe(true);
    expect(matchesSearch(item, "PANE-REDESIGN")).toBe(true);
    expect(matchesSearch(item, "9C41E7D2")).toBe(true);
    expect(matchesSearch(item, "nonexistent")).toBe(false);
  });

  test("countByIntent and filterArtifacts compute counts for current search and filter by intent", () => {
    const items: Artifact[] = [
      makeArtifact({ id: "1", title: "Spec Alpha", intent: "document" }),
      makeArtifact({ id: "2", title: "Deck Alpha", intent: "slides" }),
      makeArtifact({ id: "3", title: "Mockup Alpha", intent: "design" }),
      makeArtifact({ id: "4", title: "Notes Beta", intent: "other" }),
      makeArtifact({ id: "5", title: "Draft Alpha", intent: "document" }),
    ];

    const searchMatched = items.filter((i) => matchesSearch(i, "alpha"));
    expect(countByIntent(searchMatched)).toEqual({
      all: 4,
      document: 2,
      slides: 1,
      design: 1,
      other: 0,
    });

    expect(filterArtifacts(items, "alpha", "all").map((i) => i.id)).toEqual(["1", "2", "3", "5"]);
    expect(filterArtifacts(items, "alpha", "document").map((i) => i.id)).toEqual(["1", "5"]);
    expect(filterArtifacts(items, "alpha", "other")).toEqual([]);
  });

  test("documentsTabLabel uses Docs under 400px and Documents at 400px+", () => {
    expect(documentsTabLabel(364)).toBe("Docs");
    expect(documentsTabLabel(399)).toBe("Docs");
    expect(documentsTabLabel(400)).toBe("Documents");
    expect(documentsTabLabel(600)).toBe("Documents");
  });

  test("artifactBadges and isSharedArtifact never mark owned typed artifacts as shared", () => {
    const ownedDoc = makeArtifact({ id: "d1", owner: "mine", typeName: "Docs", contentKind: "markdown" });
    expect(isSharedArtifact(ownedDoc)).toBe(false);
    expect(artifactBadges(ownedDoc)).toEqual({ rowType: "Docs", detailType: "Docs", shared: false });

    const ownedDesign = makeArtifact({ id: "d2", owner: "mine", typeName: "Design", contentKind: "files" });
    expect(artifactBadges(ownedDesign)).toEqual({ rowType: "Design", detailType: "Design", shared: false });

    const unknownSummary = makeArtifact({ id: "d3", owner: "unknown", typeName: "Docs", contentKind: "summary" });
    expect(isSharedArtifact(unknownSummary)).toBe(false);
    expect(artifactBadges(unknownSummary)).toEqual({ rowType: "Docs", detailType: "Docs", shared: false });

    const sharedSummary = makeArtifact({ id: "d3b", owner: "shared", typeName: "Docs", contentKind: "summary" });
    expect(isSharedArtifact(sharedSummary)).toBe(true);
    expect(artifactBadges(sharedSummary)).toEqual({ rowType: "Docs", detailType: "Docs", shared: true });

    const legacyShared = makeArtifact({ id: "d4", owner: "shared", typeName: null, contentKind: null });
    expect(isSharedArtifact(legacyShared)).toBe(true);
    expect(artifactBadges(legacyShared)).toEqual({ rowType: null, detailType: null, shared: true });

    const legacyOwned = makeArtifact({ id: "d5", owner: "mine", intent: "slides", typeName: null, contentKind: null });
    expect(artifactBadges(legacyOwned)).toEqual({ rowType: null, detailType: "slides", shared: false });
  });

  test("formatAskAgentDraft uses artifact_read tool instruction and appends summary for shared items", () => {
    const owned = makeArtifact({ id: "a1", owner: "mine", contentKind: "markdown", summary: "ignored" });
    expect(formatAskAgentDraft(owned)).toBe(
      "Use this artifact: https://claude.ai/artifact/a1 (read it with the artifact_read tool)",
    );

    const shared = makeArtifact({
      id: "a2",
      owner: "shared",
      contentKind: "summary",
      summary: "Three-screen flow.",
    });
    expect(formatAskAgentDraft(shared)).toBe(
      "Use this artifact: https://claude.ai/artifact/a2 (read it with the artifact_read tool)\n\nSummary: Three-screen flow.",
    );
  });

  test("extractArtifactBoards orders .dc.html boards from canvas.json, falls back alphabetically, and ignores non-.dc.html files", () => {
    const files = [
      { path: "project/canvas.json", size: 420 },
      { path: "project/Wide-Empty.dc.html", size: 14307 },
      { path: "project/Narrow-Detail.dc.html", size: 12706 },
      { path: "project/Extra.dc.html", size: 5000 },
      { path: "preview.html", size: 8000 },
      { path: "project/index.html", size: 1200 },
    ];

    expect(
      extractArtifactBoards(files, {
        boards: [
          { title: "Wide · Empty", file: "project/Wide-Empty.dc.html" },
          { title: "Narrow · Detail", file: "Narrow-Detail.dc.html" },
          { title: "Ignored plain html", file: "preview.html" },
          { title: "Missing board", file: "project/Missing.dc.html" },
        ],
      }),
    ).toEqual([
      { path: "project/Wide-Empty.dc.html", title: "Wide · Empty", size: 14307 },
      { path: "project/Narrow-Detail.dc.html", title: "Narrow · Detail", size: 12706 },
      { path: "project/Extra.dc.html", title: "Extra", size: 5000 },
    ]);

    expect(extractArtifactBoards(files, null)).toEqual([
      { path: "project/Extra.dc.html", title: "Extra", size: 5000 },
      { path: "project/Narrow-Detail.dc.html", title: "Narrow-Detail", size: 12706 },
      { path: "project/Wide-Empty.dc.html", title: "Wide-Empty", size: 14307 },
    ]);

    expect(
      extractArtifactBoards(files, {
        sections: [
          { title: "Mobile", boards: ["Narrow-Detail"] },
          { title: "Desktop", boards: [{ file: "project/Wide-Empty.dc.html", title: "Wide · Empty" }] },
        ],
      }),
    ).toEqual([
      { path: "project/Narrow-Detail.dc.html", title: "Narrow-Detail", size: 12706, section: "Mobile" },
      { path: "project/Wide-Empty.dc.html", title: "Wide · Empty", size: 14307, section: "Desktop" },
      { path: "project/Extra.dc.html", title: "Extra", size: 5000 },
    ]);

    expect(extractArtifactBoards([{ path: "data.json", size: 128 }, { path: "preview.html", size: 400 }], null)).toEqual([]);
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  test("extractArtifactBoards handles 70+ boards via canvas.json order and alphabetical fallback", () => {
    const files = [
      { path: "project/canvas.json", size: 4096 },
      { path: "project/notes.txt", size: 100 },
      ...Array.from({ length: 70 }, (_, i) => ({
        path: `project/Screen-${70 - i}.dc.html`,
        size: 1000 + i,
      })),
    ];

    const canvas = {
      boards: Array.from({ length: 70 }, (_, i) => ({
        file: `Screen-${i + 1}.dc.html`,
        title: `Board ${i + 1}`,
      })),
    };

    const ordered = extractArtifactBoards(files, canvas);
    expect(ordered).toHaveLength(70);
    expect(ordered[0]).toEqual({ path: "project/Screen-1.dc.html", title: "Board 1", size: 1069 });
    expect(ordered[69]).toEqual({ path: "project/Screen-70.dc.html", title: "Board 70", size: 1000 });

    const fallback = extractArtifactBoards(files, null);
    expect(fallback).toHaveLength(70);
    expect(fallback[0]?.path).toBe("project/Screen-1.dc.html");
    expect(fallback[1]?.path).toBe("project/Screen-2.dc.html");
    expect(fallback[9]?.path).toBe("project/Screen-10.dc.html");
    expect(fallback[69]?.path).toBe("project/Screen-70.dc.html");
  });

  test("extractArtifactBoards supports v3 object-map boards with titles, geometry, order, and drops invalid geometry", () => {
    const files = [
      { path: "project/canvas.json", size: 800 },
      { path: "project/Animale.dc.html", size: 2000 },
      { path: "project/Main.dc.html", size: 1500 },
      { path: "project/ExtraInMap.dc.html", size: 1200 },
      { path: "project/Unlisted.dc.html", size: 900 },
    ];

    const canvas = {
      v: 3,
      boards: {
        "Animale.dc.html": { x: 470, y: 0, w: 390, h: 844, radius: 40, title: "Proprietar · Animale" },
        "Main.dc.html": { x: 0, y: -50, w: 390, h: 844, radius: 0, title: "Proprietar · Acasă" },
        "ExtraInMap.dc.html": { x: Number.NaN, y: 100, w: 0, h: -20, radius: -5, title: "Bad geom" },
        "Missing.dc.html": { x: 0, y: 0, w: 100, h: 100, title: "Missing" },
      },
      order: ["Main.dc.html", "Missing.dc.html", "Animale.dc.html"],
    };

    expect(extractArtifactBoards(files, canvas)).toEqual([
      { path: "project/Main.dc.html", title: "Proprietar · Acasă", size: 1500, x: 0, y: -50, w: 390, h: 844, radius: 0 },
      { path: "project/Animale.dc.html", title: "Proprietar · Animale", size: 2000, x: 470, y: 0, w: 390, h: 844, radius: 40 },
      { path: "project/ExtraInMap.dc.html", title: "Bad geom", size: 1200, y: 100 },
      { path: "project/Unlisted.dc.html", title: "Unlisted", size: 900 },
    ]);
  });

  test("extractCanvasNotes orders by noteOrder, appends unlisted notes, and skips invalid entries", () => {
    const canvas = {
      noteOrder: ["titlu", "missing", "badPos"],
      notes: {
        titlu: { kind: "title1", x: 0, y: -300, w: 240, maxW: 1800, text: "PetComplete" },
        badPos: { x: Number.NaN, y: 0, text: "Invalid x" },
        emptyText: { x: 10, y: 20, text: "   " },
        qareverifnota: { x: 1880, y: 20940, w: 320, fill: "teal", text: "Desktop note" },
        badWidth: { x: 10, y: 20, w: -5, maxW: 0, text: "Keep note, drop bad sizes" },
      },
    };

    expect(extractCanvasNotes(canvas)).toEqual([
      { id: "titlu", kind: "title1", x: 0, y: -300, w: 240, maxW: 1800, text: "PetComplete" },
      { id: "qareverifnota", x: 1880, y: 20940, w: 320, fill: "teal", text: "Desktop note" },
      { id: "badWidth", x: 10, y: 20, text: "Keep note, drop bad sizes" },
    ]);
    expect(extractCanvasNotes(null)).toEqual([]);
  });

  test("capabilityFileUrl encodes each path segment individually", () => {
    expect(capabilityFileUrl("http://127.0.0.1:4123/cap/abc", "/project/My Board #1?.dc.html")).toBe(
      "http://127.0.0.1:4123/cap/abc/project/My%20Board%20%231%3F.dc.html",
    );
  });

  test("canvas-math boundsOf, fitView, zoomAt, and visibleBoards", () => {
    expect(boundsOf([], [])).toBeNull();

    const boards = [
      { path: "a.dc.html", x: 0, y: 0, w: 400, h: 800 },
      { path: "b.dc.html", x: 500, y: 100, w: 300, h: 500 },
    ];
    const notes = [{ id: "t1", kind: "title1", x: 0, y: -300, w: 240, maxW: 1000, text: "Title" }];
    const b = boundsOf(boards, notes);
    expect(b).toEqual({ minX: 0, minY: -300, maxX: 1000, maxY: 800, width: 1000, height: 1100 });

    // fitView centres bounds and caps at maxZoom = 1
    const smallBounds = { minX: 100, minY: 200, maxX: 300, maxY: 400, width: 200, height: 200 };
    expect(fitView(smallBounds, 1000, 800, 48, 1)).toEqual({ x: 300, y: 100, zoom: 1 });

    // fitView scales down and centres large bounds
    const fitted = fitView(b, 1096, 646, 48, 1);
    expect(fitted.zoom).toBeCloseTo(0.5, 6);
    expect(fitted.x).toBeCloseTo(298, 6); // 548 - 500 * 0.5
    expect(fitted.y).toBeCloseTo(198, 6); // 323 - 250 * 0.5

    // zoomAt keeps cursor board point fixed and clamps to [0.05, 4]
    const startView = { x: 100, y: 50, zoom: 0.5 };
    const sx = 300;
    const sy = 250;
    const beforeBoardX = (sx - startView.x) / startView.zoom;
    const beforeBoardY = (sy - startView.y) / startView.zoom;
    const zoomed = zoomAt(startView, sx, sy, 2);
    expect(zoomed.zoom).toBe(1);
    expect((sx - zoomed.x) / zoomed.zoom).toBeCloseTo(beforeBoardX, 6);
    expect((sy - zoomed.y) / zoomed.zoom).toBeCloseTo(beforeBoardY, 6);

    expect(zoomAt(startView, sx, sy, 0.01).zoom).toBe(0.05);
    expect(zoomAt(startView, sx, sy, 100).zoom).toBe(4);

    // visibleBoards excludes off-screen boards and honours marginPx
    const view = { x: 0, y: 0, zoom: 1 };
    const visTestBoards = [
      { path: "inside.dc.html", x: 100, y: 100, w: 200, h: 200 },
      { path: "near.dc.html", x: 1050, y: 100, w: 200, h: 200 },
      { path: "far.dc.html", x: 2000, y: 100, w: 200, h: 200 },
    ];
    expect(visibleBoards(visTestBoards, view, 1000, 800, 0).map((x) => x.path)).toEqual(["inside.dc.html"]);
    expect(visibleBoards(visTestBoards, view, 1000, 800, 100).map((x) => x.path)).toEqual([
      "inside.dc.html",
      "near.dc.html",
    ]);
  });

  test("boundsOf estimates note height (64px for title1, 120px for other notes) so bottom notes are not cropped", () => {
    const boards = [{ path: "a.dc.html", x: 0, y: 0, w: 400, h: 500 }];
    const bottomTitle = [{ id: "t2", kind: "title1", x: 0, y: 600, maxW: 300, text: "Bottom heading" }];
    expect(boundsOf(boards, bottomTitle)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 400,
      maxY: 664,
      width: 400,
      height: 664,
    });

    const bottomNote = [{ id: "n2", x: 0, y: 600, w: 240, text: "Bottom card note" }];
    expect(boundsOf(boards, bottomNote)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 400,
      maxY: 720,
      width: 400,
      height: 720,
    });
  });
});
