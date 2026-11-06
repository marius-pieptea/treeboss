# Plan: Releases with agent-written changelogs

- `src/releases/range.ts`: base points (`parseBase`, `resolveBase`), the range (`rangeOf`: commits with bodies and files, diff stat, roadmap and spec progress, breaking hints, optional merged PRs through `gh`), semver (`nextVersion`, `candidates`, `suggestBump`), and version files (`detectVersionFiles`, `readVersionFile`, `renderVersion`, `writeVersionFiles`). Pure string edits for each stack.
- `src/releases/draft.ts`: `changelogPrompt` and `productPrompt` (pure), `startChangelogSession` (createLead, build mode, token recorded in `release_sessions`), `reviseDraft` (send to the session by the draft's token), `startProductReleaseNotes`.
- `src/releases/store.ts`: front matter (`parseDoc`, `renderDoc`), reading and editing drafts and records, `publishDraft` (the commit and tag, then the optional push, GitHub release and deploy as warnings).
- `src/deploy/release.ts`: `planRelease` and `cutRelease` now read the range and the version files through `src/releases/range.ts`. `writeRelease` is the shared write: version files, CHANGELOG.md, extra files, one commit, one annotated tag, and a rollback of every file if the commit fails. `assertCleanTree`, `assertNoTag`.
- `src/daemon/routes/releases.ts`: the range, the drafts (list, get, put, revise, publish) and the product notes. Registered in `src/daemon/server.ts`.
- `src/cli/commands/release.ts`: `trb release range|draft|drafts|publish|ls`, and `plan|cut` moved here. `src/cli/commands/deploy.ts` re-exports `cmdRelease`.
- Web: `web/src/features/releases/data.ts` (queries and mutations) and `ReleasesView.tsx` (range picker with preview, draft with agent, drafts list with editor and preview, revise, publish options, per-workspace timeline, product toggle). The Factory page union gets `releases`; `FactoryView` and the palette get the entry. `ReleaseDialog` is removed; the Deploy page's Release button opens the tab.
- Tests: `tests/releases.test.ts` in throwaway git repos: ranges by tag, sha and date, breaking and spec progress, each version-file stack, prerelease, the prompt, publish (tag, prepend, move, dirty-tree refusal, stale version, missing origin), the session token, and the routes.

## Decisions

- The draft's file name is the version. The agent proposes the bump when the bump is `auto`; a fixed bump fixes the version in the prompt.
- Publishing allows exactly one dirty file: the draft being published. Anything else refuses.
- After the commit nothing is rolled back. Push, GitHub release and deploy report their failures as warnings.
- A product note is written in the first repo's folder. `publishProductNote` publishes it in place with its own commit and a `product-` tag.
- A monorepo's package roots are the repo root and each workspace folder with a version file (`workspaces` of the root `package.json`, and the usual `apps`, `packages` and `services` parents). `--package` picks one.
- Undo is a revert commit plus a local tag removal. The remote tag is deleted only on request, with a delete refspec, never a force-push.
