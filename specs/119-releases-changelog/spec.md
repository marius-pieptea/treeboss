# Feature Specification: Releases with agent-written changelogs

**Feature**: `119-releases-changelog`
**Status**: Implemented
**Input**: A release covers a range of commits, not just the commits since the last tag. The operator picks the base point (a tag, a commit or a date), an agent drafts the changelog for that range, the operator edits and publishes it. Products release their repos together through one combined note.

## User Scenarios & Testing

### User Story 1 - See what a release would cover (Priority: P1)

I pick a base point (the last tag by default, any tag, a commit, or a date) and see the commits, the diff stat, the roadmap items checked, the spec tasks done, the breaking hints and, if gh is signed in, the merged PRs.

**Independent Test**: `trb release range --since 2026-10-01` prints the commits from the last commit before that day to HEAD, with the breaking hints first.

**Acceptance Scenarios**:

1. **Given** a repo with tag v1.0.0 and three commits after it, **When** I preview the range, **Then** the base is v1.0.0 and the three commits are listed newest first, each with its files and body.
2. **Given** no tag yet, **When** I preview, **Then** the range is the whole history (up to 300 commits) with a warning.
3. **Given** a commit whose subject is `feat!:` or whose body says BREAKING CHANGE, **When** I preview, **Then** it is listed as a breaking hint and the suggested bump is major.

### User Story 2 - Draft the changelog with an agent (Priority: P1)

I choose a bump (auto, patch, minor, major or prerelease) and an audience (users, developers or both). An agent reads the commits, reads the diffs where a subject is unclear, and writes one draft to `releases/drafts/<version>.md`. It does not tag, bump, commit or push.

**Independent Test**: `trb release draft --bump minor --audience users`, then `trb release drafts` lists a draft with status draft and a reason.

**Acceptance Scenarios**:

1. **Given** a range, **When** I draft, **Then** a session starts whose prompt carries the range compactly (up to 120 commits listed, the rest named), the candidate versions, the audience rules and the front matter to fill in.
2. **Given** a draft, **When** I ask the agent to revise it, **Then** the message goes to the session that wrote it and the front matter is kept.
3. **Given** a draft, **When** I edit its notes in the UI, **Then** the file is saved with the same front matter.

### User Story 3 - Publish a draft (Priority: P1)

Publishing bumps the version files, prepends the notes to CHANGELOG.md, moves the draft to `releases/<version>.md` with status published, commits `release: vX.Y.Z` and creates an annotated tag. Pushing, a GitHub release and a deploy are optional steps after the commit.

**Independent Test**: `trb release publish 1.1.0` on a clean tree commits and tags; the same on a dirty tree refuses and writes nothing.

**Acceptance Scenarios**:

1. **Given** a clean tree and a draft, **When** I publish, **Then** the version files, CHANGELOG.md and the release record are in one commit and the tag points at it.
2. **Given** an uncommitted change other than the draft, **When** I publish, **Then** it is refused and nothing is written.
3. **Given** a draft written from an older version, **When** I publish, **Then** it is refused: the notes are out of date.

### User Story 4 - Version files for every stack (Priority: P2)

The release bumps whichever manifests the package folder has. A package folder is the repo root or a workspace folder with a version file, such as `apps/web` or `packages/shared` (`listPackageRoots` in `src/releases/range.ts`), picked with `--package`. The manifests are: package.json, composer.json, pyproject.toml, Cargo.toml, app.json or app.config.*, pubspec.yaml, and a VERSION file. Expo apps also get their iOS buildNumber and Android versionCode raised by one. Each file changes only its version value.

**Independent Test**: a fixture with app.json and package.json: publishing 1.5.0 sets both, and buildNumber and versionCode each go up by one.

### User Story 5 - Product release notes (Priority: P2)

A product's combined note is drafted from each of its repos' latest published release, in the first repo's `releases/products/` folder. The operator can then publish it. Publishing marks the note published in place, commits it alone as `release: <slug> <date>` and tags `product-<slug>-<date>`. It touches no version file and no CHANGELOG.md (`publishProductNote` in `src/releases/store.ts`, `trb release publish-note`).

### Edge Cases

- A prerelease (1.2.0-beta.1) publishes as its own version and tag; the next beta counts up from it.
- A tag that already exists, or a draft whose version is not x.y.z, is refused.
- A push, GitHub release or deploy that fails after the commit is reported as a warning: the release is committed and tagged locally.
- A publish with push or a GitHub release needs an origin remote; without one it is refused before anything is written.

## Requirements

- **FR-001**: The base point is the last tag (default), any tag, a commit sha, or a date (the last commit before its start).
- **FR-002**: A range reports the commit list (sha, subject, body, author, date, files), the diff stat, the roadmap items checked, the spec tasks checked, the merged PRs (optional, through gh) and the breaking hints.
- **FR-003**: Version files are read and written for package.json, composer.json, pyproject.toml, Cargo.toml, app.json, app.config.ts/js/mjs/cjs, pubspec.yaml and VERSION. A write changes only the version value and the build counters.
- **FR-004**: Semver supports prerelease (alpha, beta, rc): `prerelease` counts up within a preid, `release` drops the suffix.
- **FR-005**: `startChangelogSession` starts a build-mode session whose prompt is compact, fixes the version when the bump is not auto, and requires the draft file and its front matter. The session's token is in the draft's front matter.
- **FR-006**: Drafts live in `releases/drafts/<version>.md`; published records in `releases/<version>.md`; product notes in `releases/products/<slug>-<date>.md`.
- **FR-007**: `publishDraft` refuses a dirty tree (the draft itself excepted), a stale `from` version, an existing tag, and a missing origin when a push is asked for.
- **FR-008**: The quick `plan` and `cut` keep their behaviour and route through the same range and version code.
- **FR-009**: The routes are under `/api/releases/…` and the CLI is `trb release range|draft|drafts|publish|publish-note|undo|ls|plan|cut`.
- **FR-011**: A product note MUST be published only from a draft, through the same write path as a release, on a clean tree and with no existing tag. It MUST NOT push unless asked.
- **FR-012**: `publishDraft` MUST take a package folder (`--package <dir>`, repo-relative, default the root) and bump the version files of that folder only. It MUST refuse a folder with no version file.
- **FR-013**: `undoRelease` (`trb release undo <version>`) MUST revert the release commit that the tag `v<version>` points at, then remove the tag locally. History is kept and nothing is force-pushed. It MUST refuse a tag that does not point at a release commit, a release commit that is not on the current branch, a dirty tree, and a revert that conflicts (the revert is aborted and the tag stays). The tag on origin MUST be deleted only with `--delete-remote-tag`, and without it the result MUST warn that the remote tag is still there.
- **FR-010**: The Factory has a Releases page (palette entry "Factory: releases"). The Deploy page's Release button opens it.

## Out of scope

- Deleting a tag on a remote without the flag, and rewriting history to undo a release.
- Verifying the agent's notes against the code. The operator reviews the draft before publish.
