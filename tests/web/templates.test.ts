import { describe, expect, test } from "bun:test";
import { argvOf, blankForm, duplicateForm, filePaths, formProblem, freeId, hasStarter, looksLikeGithub, moveId, removeFile, sameForm, setFileContent, slug, toForm, toRecipe, type Recipe } from "../../web/src/features/scaffold/logic";

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
  test("a recipe round-trips through the form unchanged; the defaults it leaves out are sent empty, so clearing them clears them", () => {
    expect(toRecipe(toForm(next))).toEqual({ ...next, practices: [], checklists: [] });
  });

  test("the practice packs and checklists a template picks come back in the form and are sent with it", () => {
    const picked = { ...next, practices: ["strict-types", "my-stack"], checklists: ["launch"] };
    expect(toForm(picked)).toMatchObject({ practices: ["strict-types", "my-stack"], checklists: ["launch"] });
    expect(toRecipe(toForm(picked))).toEqual(picked);
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
    expect(toRecipe({ ...f, repos: f.repos.map((r) => ({ ...r, url: `https://github.com/${r.url}` })) })).toEqual({ ...withRepos, practices: [], checklists: [] });
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

describe("templates form: template files", () => {
  const withFiles: Recipe = { ...next, files: { "app/page.tsx": "<h1>{{title}}</h1>", ".env.example": "A=1" } };

  test("files come into the form, are listed sorted and go back on save unchanged", () => {
    const f = toForm(withFiles);
    expect(filePaths(f)).toEqual([".env.example", "app/page.tsx"]);
    expect(toRecipe(f)).toEqual({ ...withFiles, practices: [], checklists: [] });
    expect(toForm(withFiles).files).not.toBe(withFiles.files);
  });

  test("a recipe without files sends no files field", () => {
    expect("files" in toRecipe(toForm(next))).toBe(false);
    expect(filePaths(toForm(next))).toEqual([]);
  });

  test("editing a file changes the form and the payload; removing the last one sends an empty map so the daemon clears them", () => {
    const f = toForm(withFiles);
    const edited = setFileContent(f, ".env.example", "A=2");
    expect(sameForm(f, edited)).toBe(false);
    expect(toRecipe(edited).files).toEqual({ "app/page.tsx": "<h1>{{title}}</h1>", ".env.example": "A=2" });
    expect(setFileContent(f, "nope", "x")).toBe(f);
    const empty = removeFile(removeFile(f, ".env.example"), "app/page.tsx");
    expect(toRecipe(empty).files).toEqual({});
    expect(removeFile(f, "nope")).toBe(f);
  });

  test("a duplicate keeps the files", () => {
    expect(duplicateForm(toForm(withFiles), ["nextjs"]).files).toEqual(withFiles.files);
  });
});

describe("templates form: sub-projects", () => {
  const { generate: _g, ...base } = next;
  const monorepo: Recipe = {
    ...base,
    id: "mono",
    generate: [],
    projects: [
      { dir: "apps/web", generate: ["bunx", "create-next-app@latest", "."], steps: [["bun", "install"]], files: { ".env.example": "A=1" } },
      { dir: "apps/mobile", generate: ["bunx", "create-expo-app@latest", "."], steps: [] },
    ],
  };

  test("a monorepo recipe round-trips through the form with its projects intact, as copies", () => {
    const form = toForm(monorepo);
    expect(form.projects).toEqual(monorepo.projects);
    expect(form.projects).not.toBe(monorepo.projects);
    expect(form.projects![0]!.steps).not.toBe(monorepo.projects![0]!.steps);
    expect(toRecipe(form)).toEqual({ ...monorepo, practices: [], checklists: [] });
    expect(toRecipe(form).projects).not.toBe(form.projects);
  });

  test("the form accepts an empty generator when it has projects", () => {
    const form = toForm(monorepo);
    expect(form.generate).toBe("");
    expect(formProblem(form)).toBeNull();
  });

  test("a recipe with no generator, no starter and no projects is still refused, and so is an empty projects list", () => {
    expect(formProblem({ ...toForm(next), generate: "" })).toMatch(/generator command is empty/);
    expect(formProblem({ ...toForm(monorepo), projects: [] })).toMatch(/generator command is empty/);
    expect(formProblem({ ...toForm(monorepo), projects: undefined })).toMatch(/generator command is empty/);
  });

  test("a recipe without projects sends no projects field, so a save leaves the daemon's stored ones alone", () => {
    expect("projects" in toForm(next)).toBe(false);
    expect("projects" in toRecipe(toForm(next))).toBe(false);
  });

  test("a duplicate keeps the projects", () => {
    expect(duplicateForm(toForm(monorepo), ["mono"]).projects).toEqual(monorepo.projects);
  });
});
