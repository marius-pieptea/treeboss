import { describe, expect, test } from "bun:test";
import { matchSkills } from "../../web/src/features/agent/composer-logic";

const S = (name: string, description = "") => ({ name, description });
const skills = [
  S("code-review", "Review a diff for bugs and risky changes"),
  S("commit-message", "Write a commit message from the staged diff"),
  S("seo-audit", "Audit a site for search ranking problems"),
  S("pdf", "Read and write PDF files"),
];
const names = (q: string) => matchSkills(q, skills).map((s) => s.name);

describe("skill suggestions", () => {
  test("an empty query lists every skill by name", () => {
    expect(names("")).toEqual(["code-review", "commit-message", "pdf", "seo-audit"]);
  });

  test("the exact name ranks first", () => {
    expect(names("pdf")[0]).toBe("pdf");
  });

  test("a prefix of the name finds it", () => {
    expect(names("code")).toEqual(["code-review"]);
    expect(names("com")).toEqual(["commit-message"]);
  });

  test("a word of the name finds it, not just the start", () => {
    expect(names("review")).toEqual(["code-review"]);
    expect(names("audit")).toEqual(["seo-audit"]);
  });

  test("a word of the description finds it", () => {
    expect(names("ranking")).toEqual(["seo-audit"]);
    expect(names("staged")).toEqual(["commit-message"]);
  });

  test("letters in order find it, with two or more letters", () => {
    expect(names("crv")).toEqual(["code-review"]);
    expect(names("c")).not.toContain("pdf");
  });

  test("a query that matches nothing returns nothing", () => {
    expect(names("zzz")).toEqual([]);
  });

  test("the name beats the description when both match", () => {
    const list = [S("notes", "Review the notes"), S("code-review", "Check code")];
    expect(matchSkills("review", list).map((s) => s.name)).toEqual(["code-review", "notes"]);
  });
});
