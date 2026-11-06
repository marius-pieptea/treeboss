# Plan: Golden stacks

- `src/scaffold/files.ts` template files: `templateVars`, `renderTemplate`, `checkTemplatePath`, `validateTemplateFiles`, `writeTemplateFiles`. Checks the whole set before writing.
- `src/scaffold/recipes.ts` `Recipe.files` (optional), validated in `validateRecipe`; `saveRecipe` keeps a stored `files` map when the payload does not mention `files`; the built-in list is the four starters followed by `GOLDEN_RECIPES`.
- `src/scaffold/run.ts` writes template files right after the generator and before `git init`.
- `src/scaffold/golden.ts` the `saas-next` and `expo-app` recipes: generator, steps, conventions, starter prompt, tag and the `files` map.
- `src/scaffold/templates/saas-next/{database,auth,billing,observability,project}.ts` and `src/scaffold/templates/expo-app/app.ts`: template content as exported `String.raw` strings. No backticks and no dollar-brace in the output, which a test checks.
- `tests/scaffold-golden.test.ts`: recipe validity, `checkArgv` on every step, template parsing, interpolation, path and count limits, overwrite refusal, env keys against `.env.example`, and full scaffolds with a fake generator.
- `tests/scaffold.test.ts`: default-list assertions updated for the two new defaults.

## Decisions

- Template files are written after the generator, so they never compete with the generator's own output. A file the generator made is refused, not merged.
- Package changes go through steps (`bun add`, `bun pm pkg set`), never through a template that would overwrite `package.json`.
- The monorepo recipe runs one generator per subfolder. `Recipe.projects` lists the sub-projects (`SubProject` in `src/scaffold/recipes.ts`), and `src/scaffold/run.ts` runs the root and then each project as a unit with its own working directory. `src/scaffold/golden.ts` builds `saas-monorepo` from `saas-next` and `expo-app`, and `src/scaffold/templates/saas-monorepo/root.ts` holds the root's files. A nested Playwright config makes the generated workflow run its steps in that folder (`src/ci/workflow.ts`).
- The web editor carries `files` and `projects` through a save, and shows the template files in a panel. The server also keeps them on a save that omits the key.
