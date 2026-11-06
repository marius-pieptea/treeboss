import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { startServer } from "../src/daemon/server";
import { exportHtml } from "../src/search/export";
import { ftsQuery, replaySession, resetIndex, searchTranscripts, syncIndex } from "../src/search/index";
import { redact } from "../src/search/redact";
import { resetState } from "./helpers";

const TOKEN = "search-test-token";
let srv: ReturnType<typeof startServer>;
beforeAll(() => {
  srv = startServer({ port: 0, token: TOKEN });
});
afterAll(() => srv.stop());

/** Insert a session with finished turns straight into the tables (the index only reads them). */
function seed(id: string, o: { engine?: string; cwd?: string; title?: string; created?: string; turns: Array<{ prompt: string; output?: string; tools?: string[]; at?: string; status?: string }> }) {
  const c = db();
  c.prepare("INSERT INTO sessions (id, title, root_id, engine, cwd, base_cwd) VALUES (?, ?, ?, ?, ?, ?)").run(id, o.title ?? id, id, o.engine ?? "claude", o.cwd ?? "/work/a", o.cwd ?? "/work/a");
  o.turns.forEach((t, i) => {
    const tid = `${id}_t${i + 1}`;
    c.prepare("INSERT INTO turns (id, session_id, seq, prompt, status, output, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(tid, id, i + 1, t.prompt, t.status ?? "completed", t.output ?? null, t.at ?? "2026-10-01 10:00:00");
    for (const line of t.tools ?? []) c.prepare("INSERT INTO events (session_id, turn_id, kind, text, data) VALUES (?, ?, 'tool', ?, ?)").run(id, tid, line, JSON.stringify({ kind: "tool", name: "Bash", arg: line }));
    if (t.output) c.prepare("INSERT INTO events (session_id, turn_id, kind, text, data) VALUES (?, ?, 'text', ?, ?)").run(id, tid, t.output, JSON.stringify({ kind: "text" }));
  });
}

beforeEach(() => {
  resetState();
  resetIndex();
});

describe("query building", () => {
  test("words become quoted terms, the last a prefix; syntax is neutralised", () => {
    expect(ftsQuery("fix login bug")).toBe('"fix" "login" "bug"*');
    expect(ftsQuery('AND OR NEAR( " * ^ -x')).toBe('"AND" "OR" "NEAR" "x"*');
    expect(ftsQuery("   ")).toBeNull();
    expect(ftsQuery("naïve café")).toBe('"naïve" "café"*');
  });
});

describe("indexing and search", () => {
  test("finds prompts, answers and tool lines, ranks, and gives the turn", () => {
    seed("s_a", { turns: [{ prompt: "please refactor the payment module", output: "Done, moved stripe logic" }, { prompt: "now add tests", output: "added", tools: ["npm test --watch=false"] }] });
    seed("s_b", { turns: [{ prompt: "explain websockets", output: "they are persistent connections" }] });
    const r = searchTranscripts("payment");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ session_id: "s_a", seq: 1, role: "user" });
    expect(r.hits[0].snippet).toContain("\u0001payment\u0002");
    expect(searchTranscripts("stripe").hits[0]).toMatchObject({ session_id: "s_a", seq: 1, role: "assistant" });
    expect(searchTranscripts("npm test").hits[0]).toMatchObject({ session_id: "s_a", seq: 2, role: "tool" });
    expect(searchTranscripts("persist").hits[0].session_id).toBe("s_b"); // prefix on the last word
    expect(searchTranscripts("nothingatall").hits).toEqual([]);
    expect(searchTranscripts("").hits).toEqual([]);
  });

  test("is incremental: running turns wait, finished ones are added once", () => {
    seed("s_a", { turns: [{ prompt: "alpha work", status: "running" }] });
    expect(syncIndex()).toBe(0);
    db().prepare("UPDATE turns SET status = 'completed', output = 'zeta result' WHERE session_id = 's_a'").run();
    expect(syncIndex()).toBe(1);
    expect(syncIndex()).toBe(0);
    expect(searchTranscripts("zeta").hits).toHaveLength(1);
    const count = (db().prepare("SELECT COUNT(*) AS n FROM transcript_fts").get() as { n: number }).n;
    searchTranscripts("zeta");
    expect((db().prepare("SELECT COUNT(*) AS n FROM transcript_fts").get() as { n: number }).n).toBe(count);
  });

  test("filters: workspace, engine and date", () => {
    seed("s_a", { engine: "claude", cwd: "/work/a", turns: [{ prompt: "migrate database", at: "2026-09-01 08:00:00" }] });
    seed("s_b", { engine: "codex", cwd: "/work/b", turns: [{ prompt: "migrate database", at: "2026-10-05 08:00:00" }] });
    const ids = (f: any) => searchTranscripts("migrate", f).hits.map((h) => h.session_id).sort();
    expect(ids({})).toEqual(["s_a", "s_b"]);
    expect(ids({ engine: "codex" })).toEqual(["s_b"]);
    expect(ids({ workspace: "/work/a" })).toEqual(["s_a"]);
    expect(ids({ since: "2026-10-01" })).toEqual(["s_b"]);
    expect(ids({ until: "2026-09-30" })).toEqual(["s_a"]);
    expect(ids({ since: "2026-09-01", until: "2026-09-01" })).toEqual(["s_a"]);
    expect(ids({ since: "garbage" })).toEqual(["s_a", "s_b"]);
  });

  test("a deleted session no longer shows up", () => {
    seed("s_a", { turns: [{ prompt: "ephemeral gizmo" }] });
    expect(searchTranscripts("gizmo").hits).toHaveLength(1);
    db().prepare("DELETE FROM sessions WHERE id = 's_a'").run();
    expect(searchTranscripts("gizmo").hits).toHaveLength(0);
  });
});

describe("redaction", () => {
  test("well-known token shapes and secret assignments", () => {
    const secrets = [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-proj-abcdefghijklmnopqrstuvwx",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789",
      "xoxb-123456789012-abcdefghij",
      "AKIAIOSFODNN7EXAMPLE",
      "AIzaSyA1234567890abcdefghijklmnopqrstuv",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
      "sk_live_abcdefghijklmnop",
    ];
    for (const s of secrets) expect(redact(`here ${s} end`)).toBe("here [redacted] end");
    expect(redact("API_KEY=abcd1234efgh")).toBe("API_KEY=[redacted]");
    expect(redact('"client_secret": "s3cr3tvalue!"')).toBe('"client_secret": "[redacted]"');
    expect(redact("export DB_PASSWORD='hunter2hunter2'")).toBe("export DB_PASSWORD='[redacted]'");
    expect(redact("curl -H 'Authorization: Bearer abc.def-ghi_jkl123456'")).toContain("[redacted]");
    expect(redact("postgres://admin:p4ssw0rd@db.internal/app")).toBe("postgres://admin:[redacted]@db.internal/app");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA PRIVATE KEY-----")).toBe("[redacted]");
  });

  test("ordinary text and short or numeric values survive", () => {
    const t = "we use max_tokens=4096 and input_tokens: 123456 and the token budget is fine; passwords are hashed";
    expect(redact(t)).toBe(t);
    expect(redact("git commit abc1234 fixes #12")).toBe("git commit abc1234 fixes #12");
  });
});

describe("replay and export", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const build = () => {
    seed("s_x", { title: "Deploy <b>fix</b>", turns: [{ prompt: `use token ${secret} to push`, output: "pushed <script>alert(1)</script>", tools: ["git push origin main"] }, { prompt: "thanks", status: "failed" }] });
    return replaySession("s_x")!;
  };

  test("replay carries turns with their logged lines in order", () => {
    const r = build();
    expect(r.session.id).toBe("s_x");
    expect(r.turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(r.turns[0].items.map((i) => i.kind)).toEqual(["tool", "text"]);
    expect(r.turns[0].items[0]).toMatchObject({ name: "Bash", arg: "git push origin main" });
    expect(replaySession("nope")).toBeNull();
  });

  test("the export is one self-contained, script-free, escaped, redacted file", () => {
    const html = exportHtml(build());
    expect(html).toStartWith("<!doctype html>");
    expect(html).not.toContain(secret);
    expect(html).toContain("[redacted]");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<b>fix</b>");
    expect(html).toContain("Deploy &lt;b&gt;fix&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).toContain('id="turn-2"');
  });
});

describe("API", () => {
  const call = async (p: string) => fetch(`${srv.url}${p}`, { headers: { authorization: `Bearer ${TOKEN}` } });

  test("search with filters, replay and the download", async () => {
    seed("s_a", { engine: "claude", turns: [{ prompt: "build the exporter", output: "ok" }] });
    seed("s_b", { engine: "codex", turns: [{ prompt: "build the importer", output: "ok" }] });
    const all = (await (await call("/api/search/sessions?q=build")).json()) as any;
    expect(all.hits).toHaveLength(2);
    const one = (await (await call("/api/search/sessions?q=build&engine=codex")).json()) as any;
    expect(one.hits.map((h: any) => h.session_id)).toEqual(["s_b"]);
    expect(((await (await call("/api/search/sessions?q=build&workspace=w_missing")).json()) as any).hits).toEqual([]);
    const replay = (await (await call("/api/search/sessions/s_a/replay")).json()) as any;
    expect(replay.turns[0].prompt).toBe("build the exporter");
    expect((await call("/api/search/sessions/nope/replay")).status).toBe(404);
    const file = await call("/api/search/sessions/s_a/export.html");
    expect(file.headers.get("content-type")).toContain("text/html");
    expect(file.headers.get("content-disposition")).toContain("attachment");
    expect(file.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await file.text()).toContain("build the exporter");
    expect((await fetch(`${srv.url}/api/search/sessions?q=x`)).status).toBe(401);
  });
});
