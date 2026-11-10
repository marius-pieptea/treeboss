import { describe, expect, test } from "bun:test";
import { auditRequest } from "../../web/src/features/checklists/data";
import { draftRequest, productNotesRequest } from "../../web/src/features/releases/data";

/** What the server receives: the body is JSON, so an undefined key never reaches it. */
const wire = (body: unknown) => JSON.parse(JSON.stringify(body));

describe("agent actions carry the chosen engine and model", () => {
  test("a checklist audit sends the checklist and fix flag with the choice", () => {
    const r = auditRequest("w1", { checklistId: "launch", fix: true, engine: "claude", model: "claude-opus-5-5" });
    expect(r.path).toBe("/api/workspaces/w1/checklists/audit");
    expect(wire(r.body)).toEqual({ checklistId: "launch", fix: true, engine: "claude", model: "claude-opus-5-5" });
  });

  test("a changelog draft sends the range and options with the choice", () => {
    const r = draftRequest("/repo", { base: "v1.0.0", bump: "minor", audience: "developers", engine: "codex", model: "gpt-5" });
    expect(r.path).toBe("/api/releases/%2Frepo/draft");
    expect(wire(r.body)).toEqual({ base: "v1.0.0", bump: "minor", audience: "developers", engine: "codex", model: "gpt-5" });
  });

  test("a product note sends the audience with the choice", () => {
    const r = productNotesRequest("p1", { audience: "users", engine: "claude", model: "claude-haiku-5-5" });
    expect(r.path).toBe("/api/releases/product/p1/draft");
    expect(wire(r.body)).toEqual({ audience: "users", engine: "claude", model: "claude-haiku-5-5" });
  });

  test("an empty choice keeps engine and model off the wire, so the server default applies", () => {
    expect(wire(auditRequest("w1", { checklistId: null, fix: false }).body)).toEqual({ checklistId: null, fix: false });
    expect(wire(draftRequest("/repo", { base: "", bump: "auto", audience: "both" }).body)).toEqual({ base: null, bump: "auto", audience: "both" });
    expect(wire(productNotesRequest("p1", { audience: "users" }).body)).toEqual({ audience: "users" });
  });
});
