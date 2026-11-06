import { describe, expect, test } from "bun:test";
import { alteredKeepBlocks, docMeta, firstHeading, joinFrontMatter, keepBlocks, parseFrontMatter, setGenerated, setKey, summaryLine, unbalancedKeep, yamlScalar } from "../src/docs/frontmatter";

const PAGE = `---
title: Architecture
covers:
  - src/daemon/**
  - src/sessions/**
generated:
  commit: 1a2b3c4d5e6f
  at: 2026-10-08T10:00:00.000Z
  by: claude/opus
status: draft
owner: marius   # who to ask
tags: [core, "needs review"]
---

# Architecture

The daemon owns sessions.
`;

describe("parse and join", () => {
  test("splits the block from the body and joins back byte for byte", () => {
    const fm = parseFrontMatter(PAGE);
    expect(fm.present).toBe(true);
    expect(fm.error).toBeNull();
    expect(fm.body.startsWith("\n# Architecture")).toBe(true);
    expect(joinFrontMatter(fm)).toBe(PAGE);
  });

  test("round-trips CRLF, a BOM, a missing final newline, an empty block and no block", () => {
    const samples = [PAGE.replace(/\n/g, "\r\n"), `﻿${PAGE}`, "---\ntitle: x\n---", "---\n---\nbody\n", "no front matter\n---\nnot a block\n", "", "---\ntitle: x\n"];
    for (const s of samples) expect(joinFrontMatter(parseFrontMatter(s))).toBe(s);
  });

  test("a `---` inside a value or the body does not end the block early", () => {
    const text = `---\ntitle: "a --- b"\nnote: x\n---\nbody\n---\nmore\n`;
    const fm = parseFrontMatter(text);
    expect(fm.data.title).toBe("a --- b");
    expect(fm.body).toBe("body\n---\nmore\n");
  });

  test("an unclosed block is not front matter", () => {
    const fm = parseFrontMatter("---\ntitle: x\n\n# Heading\n");
    expect(fm.present).toBe(false);
    expect(fm.body).toBe("---\ntitle: x\n\n# Heading\n");
  });

  test("broken YAML is reported, the page stays readable, and nothing is lost", () => {
    const text = "---\ntitle: [unclosed\n---\n# Body\n";
    const fm = parseFrontMatter(text);
    expect(fm.present).toBe(true);
    expect(fm.error).toBeTruthy();
    expect(fm.data).toEqual({});
    expect(joinFrontMatter(fm)).toBe(text);
  });

  test("reads the keys the module knows, tolerating wrong types", () => {
    expect(docMeta(parseFrontMatter(PAGE).data)).toEqual({
      title: "Architecture",
      covers: ["src/daemon/**", "src/sessions/**"],
      generated: { commit: "1a2b3c4d5e6f", at: "2026-10-08T10:00:00.000Z", by: "claude/opus" },
      status: "draft",
    });
    expect(docMeta({ covers: "src/**", generated: "yes", status: "weird", title: 12 })).toEqual({ title: "12", covers: ["src/**"], generated: null, status: null });
    expect(docMeta({})).toEqual({ title: null, covers: [], generated: null, status: null });
  });
});

describe("setKey and setGenerated", () => {
  test("replaces only the generated block: every other byte stays", () => {
    const out = setGenerated(PAGE, { commit: "ffff0000aaaa", at: "2026-11-01T00:00:00.000Z", by: "codex/gpt" });
    const a = parseFrontMatter(PAGE);
    const b = parseFrontMatter(out);
    expect(docMeta(b.data).generated).toEqual({ commit: "ffff0000aaaa", at: "2026-11-01T00:00:00.000Z", by: "codex/gpt" });
    expect(b.body).toBe(a.body);
    // unknown keys, the comment, the tags and the order survive untouched
    expect(out).toContain("owner: marius   # who to ask");
    expect(out).toContain('tags: [core, "needs review"]');
    expect(out.indexOf("covers:")).toBeLessThan(out.indexOf("generated:"));
    expect(out.indexOf("generated:")).toBeLessThan(out.indexOf("status: draft"));
    expect(out.replace(/generated:\n(  .*\n){3}/, "")).toBe(PAGE.replace(/generated:\n(  .*\n){3}/, ""));
  });

  test("adds the key when it is missing, at the end of the block", () => {
    const text = "---\ntitle: Notes\n---\n# Notes\n";
    const out = setGenerated(text, { commit: "abc1234", at: "2026-10-08T00:00:00.000Z", by: "manual" });
    expect(out).toBe("---\ntitle: Notes\ngenerated:\n  commit: abc1234\n  at: \"2026-10-08T00:00:00.000Z\"\n  by: manual\n---\n# Notes\n");
    expect(docMeta(parseFrontMatter(out).data).generated?.commit).toBe("abc1234");
  });

  test("creates a block on a page that has none and leaves the body alone", () => {
    const out = setKey("# Plain\n\ntext\n", "covers", ["src/**", "web/src/**"]);
    expect(out).toBe("---\ncovers:\n  - src/**\n  - web/src/**\n---\n# Plain\n\ntext\n");
  });

  test("handles a list written without indentation and a one-line flow value", () => {
    const flat = "---\ncovers:\n- a/**\n- b/**\ntitle: T\n---\nx\n";
    const out = setKey(flat, "covers", ["c/**"]);
    expect(out).toBe("---\ncovers:\n  - c/**\ntitle: T\n---\nx\n");
    const inline = "---\ngenerated: { commit: abc, by: x }\ntitle: T\n---\nx\n";
    const out2 = setKey(inline, "generated", { commit: "def", by: "y" });
    expect(docMeta(parseFrontMatter(out2).data).generated).toMatchObject({ commit: "def", by: "y" });
    expect(parseFrontMatter(out2).data.title).toBe("T");
  });

  test("keeps CRLF line endings and a BOM", () => {
    const crlf = PAGE.replace(/\n/g, "\r\n");
    const out = setGenerated(crlf, { commit: "9999", at: "2026-01-01T00:00:00.000Z", by: "m" });
    expect(out.includes("\r\n")).toBe(true);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    const bom = setKey(`﻿---\ntitle: x\n---\nb\n`, "status", "reviewed");
    expect(bom.startsWith("﻿---\n")).toBe(true);
    expect(parseFrontMatter(bom).data.status).toBe("reviewed");
  });

  test("undefined removes the key and its lines", () => {
    const out = setKey(PAGE, "covers", undefined);
    expect(out).not.toContain("covers:");
    expect(out).not.toContain("src/daemon/**");
    expect(parseFrontMatter(out).data.title).toBe("Architecture");
  });

  test("quotes what YAML would misread", () => {
    expect(yamlScalar("claude/opus")).toBe("claude/opus");
    expect(yamlScalar("true")).toBe('"true"');
    expect(yamlScalar("2026-10-08T10:00:00Z")).toBe('"2026-10-08T10:00:00Z"');
    expect(yamlScalar("a: b")).toBe('"a: b"');
    expect(yamlScalar("")).toBe('""');
    const out = setKey("---\ntitle: x\n---\n", "by", "model: v2 # note");
    expect(parseFrontMatter(out).data.by).toBe("model: v2 # note");
  });
});

describe("keep blocks", () => {
  const BEFORE = "# T\n\nGenerated text.\n\n<!-- keep -->\nOur on-call rota lives in the wiki.\n<!-- /keep -->\n\nMore generated text.\n";

  test("finds them and tells preserved from altered", () => {
    expect(keepBlocks(BEFORE)).toHaveLength(1);
    expect(alteredKeepBlocks(BEFORE, BEFORE.replace("Generated text.", "Rewritten text."))).toEqual([]);
    expect(alteredKeepBlocks(BEFORE, BEFORE.replace("on-call rota", "pager rota"))).toHaveLength(1);
    expect(alteredKeepBlocks(BEFORE, "# T\n\nNothing kept.\n")).toHaveLength(1);
    // moving a block elsewhere on the page is fine: it is the text that must survive
    expect(alteredKeepBlocks(BEFORE, `<!-- keep -->\nOur on-call rota lives in the wiki.\n<!-- /keep -->\n# T\n`)).toEqual([]);
  });

  test("two identical blocks are matched one for one", () => {
    const two = "<!-- keep -->\nx\n<!-- /keep -->\n\n<!-- keep -->\nx\n<!-- /keep -->\n";
    expect(alteredKeepBlocks(two, "<!-- keep -->\nx\n<!-- /keep -->\n")).toHaveLength(1);
  });

  test("flags an unbalanced marker", () => {
    expect(unbalancedKeep(BEFORE)).toBe(false);
    expect(unbalancedKeep("<!-- keep -->\nopen\n")).toBe(true);
    expect(unbalancedKeep("closed\n<!-- /keep -->\n")).toBe(true);
  });
});

describe("page text helpers", () => {
  test("title and summary come from the body", () => {
    const body = "\n```\n# not a heading\n```\n\n# Real title\n\n> a quote\n\nThe daemon owns **sessions** and `turns`.\n\n- a list\n";
    expect(firstHeading(body)).toBe("Real title");
    expect(summaryLine(body)).toBe("The daemon owns sessions and turns.");
    expect(summaryLine("# Only a heading\n")).toBe("");
    expect(summaryLine("x ".repeat(300), 40).length).toBe(40);
  });
});

describe("globs in covers", () => {
  test("a leading star is quoted (it would read as a YAML alias), a mid-path star is not", () => {
    expect(yamlScalar("src/**/*.ts")).toBe("src/**/*.ts");
    expect(yamlScalar("**/*.ts")).toBe('"**/*.ts"');
    const out = setKey("---\ntitle: x\n---\n", "covers", ["**/*.ts", "src/**"]);
    expect(parseFrontMatter(out).data.covers).toEqual(["**/*.ts", "src/**"]);
  });
});
