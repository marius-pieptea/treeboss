import { describe, expect, test } from "bun:test";
import { argvOf, blankForm, duplicateForm, formProblem, freeId, hasStarter, looksLikeGithub, moveId, sameForm, slug, toForm, toRecipe, type Recipe } from "../../web/src/features/scaffold/logic";

const next: Recipe = {
  id: "nextjs",
  name: "Next.js",
  description: "d",
  generate: ["bunx", "create-next-app@latest", ".", "--import-alias", "@/*"],
  steps: [["bun", "install"]],
  conventions: ["Rule one", "Rule two"],
  intro: "i",
  starterPrompt: "Go\n\nThe app: ",
  icon: "globe",
  tag: "web",
  builtinId: "nextjs",
};

describe("templates form", () => {
  test("a recipe round-trips through the form unchanged", () => {
    expect(toRecipe(toForm(next))).toEqual(next);
  });

  test("an argument with a space survives as one argument", () => {
    const f = { ...toForm(next), generate: `bunx create-x . --title "My App" --x='a b'` };
    expect(toRecipe(f).generate).toEqual(["bunx", "create-x", ".", "--title", "My App", "--x=a b"]);
    expect(argvOf("  ")).toEqual([]);
  });

  test("blank steps and blank rules are dropped on the way out", () => {
    const f = { ...toForm(next), steps: ["bun install", "   ", ""], rules: "a\n\n  b  \n" };
    const r = toRecipe(f);
    expect(r.steps).toEqual([["bun", "install"]]);
    expect(r.conventions).toEqual(["a", "b"]);
  });

  test("ids: slug, free id and the new/duplicate forms", () => {
    expect(slug("My Cool App!")).toBe("my-cool-app");
    expect(slug("***")).toBe("template");
    expect(freeId("Next.js", ["next-js", "next-js-2"])).toBe("next-js-3");
    const b = blankForm(["my-template"]);
    expect(b).toMatchObject({ id: "my-template-2", isNew: true });
    const d = duplicateForm(toForm(next), ["nextjs"]);
    expect(d).toMatchObject({ id: "next-js-copy", isNew: true, name: "Next.js copy", builtinId: undefined });
  });

  test("problems and dirtiness", () => {
    const f = toForm(next);
    expect(formProblem(f)).toBeNull();
    expect(formProblem({ ...f, name: " " })).toMatch(/name/);
    expect(formProblem({ ...f, generate: "  " })).toMatch(/empty/);
    expect(sameForm(f, toForm(next))).toBe(true);
    expect(sameForm(f, { ...f, tag: "x" })).toBe(false);
  });

  test("moveId swaps neighbours and stops at the ends", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveId(["a", "b", "c"], "x", 1)).toEqual(["a", "b", "c"]);
  });
});

describe("templates form: GitHub repos", () => {
  const withRepos: Recipe = { ...next, repos: [{ url: "https://github.com/acme/ui", ref: "v2", role: "reference", note: "its tokens" }] };

  test("repos round-trip through the form, shown as owner/repo", () => {
    const f = toForm(withRepos);
    expect(f.repos).toEqual([{ url: "acme/ui", ref: "v2", role: "reference", note: "its tokens" }]);
    expect(toRecipe({ ...f, repos: f.repos.map((r) => ({ ...r, url: `https://github.com/${r.url}` })) })).toEqual(withRepos);
  });

  test("a recipe without repos stays without a repos field; empty rows are ignored", () => {
    expect("repos" in toRecipe(toForm(next))).toBe(false);
    expect("repos" in toRecipe({ ...toForm(next), repos: [{ url: " ", ref: "", role: "reference", note: "" }] })).toBe(false);
  });

  test("a starter repo replaces the generator: the form must have none, and may save without one", () => {
    const f = { ...toForm(next), generate: "", repos: [{ url: "acme/starter", ref: "", role: "starter" as const, note: "" }] };
    expect(hasStarter(f)).toBe(true);
    expect(formProblem(f)).toBeNull();
    expect(toRecipe(f).generate).toEqual([]);
    expect(formProblem({ ...f, generate: "bunx create-x ." })).toMatch(/clear the generator/);
    expect(formProblem({ ...f, repos: [] })).toMatch(/generator command is empty/);
  });

  test("only one starter, and only GitHub repos", () => {
    const two = { ...toForm(next), generate: "", repos: [{ url: "a/b", ref: "", role: "starter" as const, note: "" }, { url: "c/d", ref: "", role: "starter" as const, note: "" }] };
    expect(formProblem(two)).toMatch(/one repo/);
    expect(formProblem({ ...toForm(next), repos: [{ url: "https://gitlab.com/a/b", ref: "", role: "reference", note: "" }] })).toMatch(/not a GitHub/);
  });

  test("the URL check accepts the three shapes and refuses the rest", () => {
    for (const ok of ["acme/ui", "github.com/acme/ui", "https://github.com/acme/ui.git", "https://www.github.com/acme/ui/"]) expect(looksLikeGithub(ok), ok).toBe(true);
    for (const bad of ["https://gitlab.com/acme/ui", "git@github.com:acme/ui.git", "acme", "", "example.com/a", "https://github.com/acme/ui/tree/main", "acme/.."]) expect(looksLikeGithub(bad), bad).toBe(false);
  });

  test("a duplicate keeps the repos", () => {
    expect(duplicateForm(toForm(withRepos), ["nextjs"]).repos).toEqual(toForm(withRepos).repos);
  });
});

describe("new project helpers", () => {
  test("clone folder name comes from the repository", async () => {
    const { repoFolderName, projectTarget } = await import("../../web/src/features/scaffold/logic");
    expect(repoFolderName("acme/app")).toBe("app");
    expect(repoFolderName("https://github.com/acme/app.git/")).toBe("app");
    expect(repoFolderName("git@github.com:acme/app.git")).toBe("app");
    expect(repoFolderName("")).toBe("");
    expect(projectTarget("/Users/me/code/", " app ")).toBe("/Users/me/code/app");
  });
});
