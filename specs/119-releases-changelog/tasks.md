# Tasks: Releases with agent-written changelogs

- [x] T001 Base points (tag, any tag, sha, date) and the last-tag default, in `src/releases/range.ts`
- [x] T002 Range: commits with body, author, date and files; diff stat; roadmap and spec tasks checked in the range; breaking hints
- [x] T003 Merged PRs through gh, optional and silent when gh is missing or signed out
- [x] T004 Semver with prerelease (alpha, beta, rc): `nextVersion`, `release`, `candidates`, `suggestBump`
- [x] T005 Version files for package.json, composer.json, pyproject.toml, Cargo.toml, app.json, app.config.*, pubspec.yaml and VERSION, written surgically
- [x] T006 Expo buildNumber and Android versionCode go up by one on each release
- [x] T007 `planRelease` and `cutRelease` route through the range and version code; the existing tests stay green
- [x] T008 Changelog prompt: compact range, candidate versions, audience rules, front matter with the session token, the rules not to tag or commit
- [x] T009 `startChangelogSession` records the token in `release_sessions`; `reviseDraft` sends to the session that wrote the draft
- [x] T010 Front matter and drafts in `releases/drafts/`, published records in `releases/<version>.md`, edits keep the front matter
- [x] T011 `publishDraft`: refuses a dirty tree (the draft excepted), a stale `from`, an existing tag, a missing origin; commit `release: vX.Y.Z`; annotated tag; CHANGELOG prepend; draft moved to a published record
- [x] T012 Optional push, GitHub release and deploy after the commit, reported as warnings on failure
- [x] T013 Product note prompt and `startProductReleaseNotes` across a product's repos (draft only)
- [x] T014 Routes under `/api/releases/…`, registered in the daemon
- [x] T015 CLI `trb release range|draft|drafts|publish|ls`; `plan|cut` moved to the same module
- [x] T016 Web: Releases page in the Factory, palette entry "Factory: releases", the Deploy Release button opens it, `ReleaseDialog` removed
- [x] T017 Web: base picker with range preview, draft with agent (bump, audience), drafts list, markdown editor and preview, revise, publish options, published timeline, product toggle
- [x] T018 Tests in `tests/releases.test.ts`: ranges, version stacks, prerelease, prompt, publish, session token, routes
- [x] T021 Product note publish (`publishProductNote` in src/releases/store.ts, `trb release publish-note`)
- [x] T022 Monorepo package roots (`listPackageRoots` in src/releases/range.ts, `--package` on `trb release publish`)
- [x] T023 Undo of a published release: a revert commit and tag removal, the remote tag only with `--delete-remote-tag` (`undoRelease` in src/releases/store.ts, `trb release undo`)

## Live checks

These need an account, a CLI or the network this machine does not have. They are not tasks, so the specs view does not count them.

- T019 Live check against a real GitHub remote and gh release. Needs a real GitHub remote and a signed-in `gh`.
- T020 Live check of a draft session with a real engine. The prompt is tested, the agent's output is not. Needs a real engine.
