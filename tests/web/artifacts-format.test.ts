import { describe, expect, test } from "bun:test";
import type { Artifact } from "../../web/src/features/artifacts/data";
import {
  countByIntent,
  documentsTabLabel,
  filterArtifacts,
  groupArtifacts,
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
});
