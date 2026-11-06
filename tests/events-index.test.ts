import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { db, migrate } from "../src/db";

const indexNames = (conn: Database) => (conn.prepare("PRAGMA index_list(events)").all() as Array<{ name: string }>).map((r) => r.name);

describe("events index by turn_id", () => {
  test("the per-turn MIN(id) lookup uses idx_events_turn instead of scanning the log", () => {
    expect(indexNames(db())).toContain("idx_events_turn");
    const plan = (db().prepare("EXPLAIN QUERY PLAN SELECT MIN(id) AS id FROM events WHERE turn_id = ?").all("t") as Array<{ detail: string }>).map((r) => r.detail).join("\n");
    expect(plan).toContain("idx_events_turn");
  });

  test("an existing database that predates the index gets it on open", () => {
    // The old shape of events: only the session index, as released before this change.
    const old = new Database(":memory:");
    old.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_id TEXT,
      ts TEXT DEFAULT CURRENT_TIMESTAMP, kind TEXT NOT NULL, text TEXT NOT NULL
    )`);
    old.exec("CREATE INDEX idx_events_session ON events(session_id, id)");
    expect(indexNames(old)).not.toContain("idx_events_turn");
    migrate(old);
    expect(indexNames(old)).toContain("idx_events_turn");
    old.close();
  });
});
