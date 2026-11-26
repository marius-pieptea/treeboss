import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { db, migrate } from "../src/db";
import {
  addPasted,
  getArtifact,
  listArtifacts,
  markRemoved,
  purgeRemoved,
  recordPublished,
  restore,
  saveError,
  saveRead,
} from "../src/artifacts/store";
import { artifactIdFromUrl, intentFromPath, parsePublished } from "../src/artifacts/capture";
import { resetState } from "./helpers";

beforeEach(() => {
  resetState();
  db().exec("DELETE FROM artifacts");
});

describe("artifacts capture helpers", () => {
  test("parses both artifact URL shapes and infers intent", () => {
    expect(parsePublished("Published a.html at https://claude.ai/artifact/art-1 (Version 1)")).toBe(
      "https://claude.ai/artifact/art-1",
    );
    expect(parsePublished("at https://claude.ai/code/artifact/550e8400-e29b-41d4-a716-446655440000 done")).toBe(
      "https://claude.ai/code/artifact/550e8400-e29b-41d4-a716-446655440000",
    );
    expect(artifactIdFromUrl("https://claude.ai/artifact/art-1")).toBe("art-1");
    expect(artifactIdFromUrl("https://claude.ai/code/artifact/550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(artifactIdFromUrl("https://claude.ai/chat/123")).toBeNull();
    expect(intentFromPath("q4.pptx", "Review")).toBe("slides");
    expect(intentFromPath("app.html", "Settings UI")).toBe("design");
    expect(intentFromPath("spec.md", "Architecture Spec")).toBe("document");
    expect(intentFromPath("build_tool.html", "Build Tool")).toBe("other");
  });
});

describe("artifacts store", () => {
  test("upserts on a second publish, updating title and updatedAt and clearing htmlPath", () => {
    db()
      .prepare("INSERT INTO sessions (id, title, root_id, engine, cwd, base_cwd) VALUES (?, ?, ?, 'claude', '/tmp', '/tmp')")
      .run("s_1", "Landing page session", "s_1");

    const first = recordPublished({
      url: "https://claude.ai/artifact/v1-id",
      title: "Draft 1",
      filePath: "mockup.html",
      sessionId: "s_1",
    });
    expect(first.id).toBe("v1-id");
    expect(first.source).toBe("created");
    expect(first.owner).toBe("mine");
    expect(first.intent).toBe("design");
    expect(first.sessionTitle).toBe("Landing page session");
    expect(first.updatedAt).toBeNull();

    const read = saveRead("v1-id", { htmlPath: "/tmp/index.html", owner: "mine" });
    expect(read?.htmlPath).toBe("/tmp/index.html");
    expect(read?.lastReadAt).not.toBeNull();

    const second = recordPublished({
      url: "https://claude.ai/artifact/v1-id",
      title: "Final Design",
      filePath: "mockup.html",
      sessionId: "s_1",
    });
    expect(second.title).toBe("Final Design");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBeNull();
    expect(second.htmlPath).toBeNull();
    expect(second.lastReadAt).toBeNull();
  });

  test("remove, restore, and list excluding removed", () => {
    recordPublished({ url: "https://claude.ai/artifact/a1", title: "One", filePath: "doc.md", sessionId: null });
    recordPublished({ url: "https://claude.ai/artifact/a2", title: "Two", filePath: "deck.pptx", sessionId: null });

    expect(markRemoved("a1")).toBe(true);
    expect(markRemoved("a1")).toBe(false);
    expect(getArtifact("a1")).toBeNull();
    expect(listArtifacts().map((a) => a.id)).toEqual(["a2"]);

    const restored = restore("a1");
    expect(restored?.id).toBe("a1");
    expect(listArtifacts().map((a) => a.id).sort()).toEqual(["a1", "a2"]);

    markRemoved("a1");
    expect(purgeRemoved(60_000)).toBe(0);
    expect(purgeRemoved(0)).toBe(1);
    expect(restore("a1")).toBeNull();
  });

  test("40+ rows return newest createdAt first in order", () => {
    const base = 1_700_000_000_000;
    const insert = db().prepare(
      "INSERT INTO artifacts (id, url, title, intent, owner, source, created_at) VALUES (?, ?, ?, 'other', 'mine', 'created', ?)",
    );
    for (let i = 0; i < 45; i++) {
      insert.run(`art_${i}`, `https://claude.ai/artifact/art_${i}`, `Artifact ${i}`, base + i * 1000);
    }
    const items = listArtifacts();
    expect(items).toHaveLength(45);
    expect(items[0].id).toBe("art_44");
    expect(items[44].id).toBe("art_0");
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].createdAt).toBeGreaterThan(items[i].createdAt);
    }
  });

  test("addPasted, saveError, and migrate on a fresh database", () => {
    const pasted = addPasted("https://claude.ai/code/artifact/550e8400-e29b-41d4-a716-446655440000");
    expect(pasted.source).toBe("pasted");
    expect(pasted.owner).toBe("unknown");
    const errored = saveError(pasted.id, "no_access", "403 forbidden");
    expect(errored?.error).toBe("no_access");
    expect(errored?.errorText).toBe("403 forbidden");
    const recovered = saveRead(pasted.id, { summary: "Shared summary", owner: "shared" });
    expect(recovered?.error).toBeNull();
    expect(recovered?.errorText).toBeNull();
    expect(recovered?.owner).toBe("shared");

    const fresh = new Database(":memory:");
    migrate(fresh);
    const cols = fresh.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("removed_at");
    const indexes = fresh
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'artifacts'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("artifacts_created");
    fresh.close();
  });
});
