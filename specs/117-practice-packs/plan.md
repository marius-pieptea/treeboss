# Plan: Practice packs

- `src/practices/packs.ts` the built-in catalog as data, the stack tags, the check ids and the check to pack map.
- `src/practices/store.ts` the per-workspace table `practice_settings` (created lazily), `<home>/practices.json` for custom packs (`readCustom`, `createCustom`, `updateCustom`, `deleteCustom`, `checkCustom`), `setPractices` (validates, then writes both files, then the row), and `spliceBlock`, the practices block with its own markers. It reuses memory's file helpers (`fileIn`, `read`, `writeAtomic`, `mirrorSkipReason`), exported from `src/memory/store.ts` for this.
- `src/practices/files.ts` the file list: `git ls-files` for the whole repo, `git diff HEAD` plus untracked for the changed files.
- `src/practices/checks.ts` the heuristic checks over stripped code (`stripCode`) and over template markup, `checksFor` (the checks that read a file), `runChecks`, `checksOf`, `checkFiles` and `skippedFiles` (the main stack's unread files), `practiceReport`, and `practiceFindings(root, changedFiles, workspaceDir)`, which never throws.
- `src/practices/templates.ts` template files: the `TEMPLATE` extensions, `maskTemplate` (blanks the template syntax and, unless asked, the code blocks, keeping every newline and column), `markupOf`, `layoutRef` (the layout a page names), and `isTemplatePage`. `checks.ts` reads the named layouts from the template directories.
- `src/treeboss/gate.ts` after the existing checks, the practice findings join `violations` (labelled `[pack] file:line message`). `practiceFindings` is called with the session's directory and its base directory; with no pack enabled it returns before reading any file.
- `src/daemon/routes/practices.ts` the catalog, custom pack CRUD, and the workspace settings and check routes.
- `src/cli/commands/practices.ts` `trb practices ls|enable|disable|check`.
- `web/src/features/practices` `data.ts` hooks and `PracticesPanel.tsx`: toggle cards with expandable rules, a thresholds form, and Check now.
- Tests: `tests/practices.test.ts`: the pure checks, the block, the settings per workspace, custom packs, `practiceFindings`, the routes, and two gate turns.

Not in this slice: the registration lines for the server, the CLI index and the web shell (in the report). Custom packs have no web editor yet; they are edited through the routes or the file.
