import { appendFileSync as __af } from "fs";
import { afterAll as __aa } from "bun:test";
__af(process.env.TRACE_LOG!, new Date().toISOString() + " START treeboss-research\n");
__aa(() => { __af(process.env.TRACE_LOG!, new Date().toISOString() + " END treeboss-research\n"); });
import { describe, expect, test } from "bun:test";
import { evidenceToolDefs } from "../src/evidence/defs";
import { AFTER_RESEARCH_PICK, CANDIDATES_FILE, RESEARCH_RULES } from "../src/treeboss/research";

const TEXT = `${RESEARCH_RULES}\n${AFTER_RESEARCH_PICK}`;
// Tool-like identifiers this text may name: the evidence_* and investigation_* tools. The other tools it names
// (REA's inspect_electron_page and the rest) come from the REA server, not from src/evidence/defs.ts.
const TOOL_LIKE = /\b(?:evidence|investigation)_[a-z_]+\b/g;

describe("treeboss research rules", () => {
  test("write the candidates page, then stop for the operator's pick", () => {
    expect(CANDIDATES_FILE).toBe("research/candidates.html");
    expect(RESEARCH_RULES).toContain(CANDIDATES_FILE);
    expect(RESEARCH_RULES).toMatch(/\*\*Stop\.\*\*/);
    expect(RESEARCH_RULES).toMatch(/wait for the operator's pick/);
    expect(RESEARCH_RULES.split("\n").length).toBeLessThanOrEqual(30);
  });

  test("after the pick: investigate, capture, record findings, spec and build, then delete the page", () => {
    expect(AFTER_RESEARCH_PICK).toContain("investigation_start");
    expect(AFTER_RESEARCH_PICK).toContain("evidence_capture_page");
    expect(AFTER_RESEARCH_PICK).toContain("evidence_finding");
    expect(AFTER_RESEARCH_PICK).toContain("investigation_close");
    expect(AFTER_RESEARCH_PICK).toContain(`Delete ${CANDIDATES_FILE}`);
  });

  test("names only evidence and investigation tools that src/evidence/defs.ts defines", () => {
    const known = new Set(evidenceToolDefs().map((d) => d.name));
    const named = [...new Set(TEXT.match(TOOL_LIKE) ?? [])];
    expect(named).toContain("evidence_finding");
    expect(named.filter((n) => !known.has(n))).toEqual([]);
  });
});
