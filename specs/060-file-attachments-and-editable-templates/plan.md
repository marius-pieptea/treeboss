# Plan: Attach any file, and editable templates

## Attachments

- `src/context/zip.ts` hardened zip reader and extractor (limits, zip-slip, symlinks, bombs).
- `src/context/files.ts` store, type detection, PDF/docx/HTML extraction, per-type description, cleanup sweep.
- `src/context/resolve.ts` new chip kind `upload`; `raw` bodies carry their own fences; per-message byte cap.
- `src/daemon/routes/context.ts` `POST /api/context/files`, `GET /api/context/files/:id`; a new session titled from the operator's sentence rather than from the folded block.
- Web: `features/context` (file paste/drop/pick, chips with size, limits), a "Attach files…" item in the `+` menu.

## Templates

- `src/scaffold/recipes.ts` the store (seed once, reset, restore, reorder, validate), `steps` replaces `install`.
- `src/scaffold/run.ts` runs the steps in order.
- `src/daemon/routes/scaffold.ts` PUT, reset, restore-defaults, reorder; list returns `isDefault`, `modified`, `missingDefaults`.
- Web: `features/scaffold/TemplatesPage.tsx` (form editor), `logic.ts`, `icons.tsx`; the New app dialog reads the same query; one additive page entry in the Settings shell (`store.ts`, `SettingsSidebar`, `SettingsTab`, `commands`).

## Verification

`tests/attach-files.test.ts`, `tests/scaffold.test.ts`, `tests/web/file-attachments.test.ts`, `tests/web/templates.test.ts`, and `scripts/ui-attach-templates.ts` (headless Chrome, isolated daemon, scripted engine).
