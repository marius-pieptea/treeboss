import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { SkillStore, parseSkillInvocation } from "../src/skills/store";
import { db } from "../src/db";
import { resetState } from "./helpers";

beforeEach(() => {
  resetState();
  db().exec("DELETE FROM skills");
});
afterEach(() => {
  db().exec("DELETE FROM skills");
});

function skill(name: string, enabled = true) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trb-inv-")), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: skill ${name}\n---\nbody\n`);
  const rec = SkillStore.add(dir);
  if (!enabled) SkillStore.setEnabled(name, false);
  return rec;
}

describe("skill invocation by typed name", () => {
  test("an exact name calls the skill and keeps the rest of the message", () => {
    skill("code-review");
    const inv = parseSkillInvocation("/code-review check the auth module");
    expect(inv?.skill.name).toBe("code-review");
    expect(inv?.rest).toBe("check the auth module");
  });

  test("a partial name that identifies one skill calls it", () => {
    skill("code-review");
    skill("pdf");
    expect(parseSkillInvocation("/rev fix the bug")?.skill.name).toBe("code-review");
    expect(parseSkillInvocation("/pd")?.skill.name).toBe("pdf");
  });

  test("a word of the name calls the skill", () => {
    skill("seo-audit");
    expect(parseSkillInvocation("/audit the home page")?.skill.name).toBe("seo-audit");
  });

  test("an ambiguous partial name sends the text as typed", () => {
    skill("code-review");
    skill("review-pr");
    expect(parseSkillInvocation("/review this")).toBeNull();
  });

  test("a disabled skill is not called, even by its exact name", () => {
    skill("pdf", false);
    expect(parseSkillInvocation("/pdf read this")).toBeNull();
  });

  test("text that is not a skill call is left alone", () => {
    skill("code-review");
    expect(parseSkillInvocation("/etc/hosts is wrong")).toBeNull();
    expect(parseSkillInvocation("please /code-review this")).toBeNull();
  });
});
