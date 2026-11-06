# Tasks: Golden stacks

- [x] T001 Template file mechanism: path checks, placeholders, overwrite refusal, with tests
- [x] T002 Recipe model: optional `files`, validation, editor saves keep it, with tests
- [x] T003 Scaffold run: template files after the generator, before git init
- [x] T004 `saas-next` recipe: generator, steps, conventions, files (database, auth, billing, observability, project)
- [x] T005 `expo-app` recipe: generator, steps, conventions, files (app config, EAS profiles, API client, Sentry, store metadata)
- [x] T006 Tests: recipe validity, `checkArgv` on every step, template syntax, env keys against `.env.example`, full scaffolds
- [x] T009 Web editor: carry `files` through the form so it is visible (Template files panel in web/src/features/scaffold/TemplatesPage.tsx and logic.ts)
- [x] T010 `saas-monorepo` recipe (`SubProject` and `Recipe.projects` in src/scaffold/recipes.ts, a runner unit per project in src/scaffold/run.ts, the recipe in src/scaffold/golden.ts, its root files in src/scaffold/templates/saas-monorepo/root.ts, nested Playwright working-directory in src/ci/workflow.ts)

## Live checks

These need a network or an account this machine does not have. They are not tasks, so the specs view does not count them.

- T007 Run a real `saas-next` and `expo-app` scaffold on a machine with network, then type-check the generated projects. Needs network access.
- T008 Check `bun pm pkg set` and the Better Auth, Stripe and Sentry APIs against their current releases. Needs network access.
