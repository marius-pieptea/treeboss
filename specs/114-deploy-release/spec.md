# Feature Specification: Deploy targets, deploy history, rollback, domains and releases

**Feature**: `114-deploy-release`
**Status**: Implemented
**Input**: A workspace can ship its own app to the hosts it already uses (Cloudflare, Vercel, Fly.io, or its own command) per environment (dev, staging, prod), see what is live and what the last attempt did, roll back to the deploy before the live one, point a domain at it, and cut a semver release with a changelog built from conventional commits and the roadmap items checked since the last tag.

## Why this is not the Cloudflare feature spec 030 removed

Spec 030 removed two things: the Cloudflare Pages deploy of TreeBoss's own docs site, and Cloudflare Tunnel as a way to reach the daemon from other devices. This spec is a different concern, and the difference decides the design:

- **Whose app.** Spec 030 concerned TreeBoss's own infrastructure, which the owner does not run on Cloudflare. This feature ships the *user's project* to whichever host the user chose. It is per workspace and per target; TreeBoss has no hosting of its own.
- **Who it exposes.** Remote access puts the daemon itself on a network address, so it is default-off, guarded by pairing and Host rules, and stays out of the deploy path. A deploy target publishes a build the user made, to a host they already have, and runs only when the user asks (or from the CLI).
- **What it holds.** Remote access holds the device grants. A deploy holds provider tokens (`CLOUDFLARE_API_TOKEN`, `VERCEL_TOKEN`, `FLY_API_TOKEN`) in the secrets store, scoped to a workspace and environment. They reach the provider's child process environment only, and never argv, logs or responses.
- **Where it runs.** The remote feature is the daemon's listener. A deploy is a child process of a provider CLI, run in the workspace folder with an argv array, never a shell.

Nothing from spec 030 is reintroduced. The `src/deploy` module is new code. A legacy `deploys` table that spec 030 left in some databases is never reused (see [Assumptions](#assumptions)).

## User Scenarios & Testing

### User Story 1 - Ship an environment and see what is live (Priority: P1)

I set up a target for an environment with the provider that hosts it. I press Deploy on its card. The card shows the provider, the live URL, the version and commit, and the last attempt's status and log, and updates while the deploy runs.

**Why this priority**: shipping and seeing the result is the feature. Everything else is a safety net around it.

**Independent Test**: with a `command` target whose argv prints `https://app.example.test`, `runDeploy(target)` returns a queued row; after `waitDeploy`, the row is `succeeded` with that URL, the target's URL is updated, and `GET /api/deploys/:id` returns the same.

**Acceptance Scenarios**:

1. **Given** a dev target and a deploy that succeeds, **When** the job ends, **Then** the deploy is `succeeded`, carries the URL the CLI printed, the package version and the git commit, and the target shows that URL.
2. **Given** a deploy in progress, **When** I open the card, **Then** the log tail grows as the CLI prints, and the Deploy button is disabled.
3. **Given** the CLI exits non-zero or is not installed, **When** the job ends, **Then** the deploy is `failed` with the reason in its log tail, and the previous live URL stays on the target.
4. **Given** a prod deploy, **When** I press Deploy, **Then** I am asked to confirm first.

### User Story 2 - Roll back to the deploy before the live one (Priority: P1)

When a deploy is bad, I press Roll back on the live deploy. The earlier successful deploy becomes live again, and the history shows a rollback row.

**Why this priority**: a fast way back is what makes frequent deploys safe.

**Independent Test**: deploy A, then deploy B. `rollbackDeploy(B)` queues a rollback whose target is A's artifact; after the job, the target's URL is A's and the history reads rollback, B, A.

**Acceptance Scenarios**:

1. **Given** deploys A then B (live), **When** I roll back B, **Then** A's artifact is made live through the provider's own rollback, and a `rollback` row records it.
2. **Given** only one successful deploy, **When** I try to roll back, **Then** I am told there is no earlier successful deploy to go back to.
3. **Given** an older deploy that is not live, **When** I try to roll back from it, **Then** I am told only the live deploy can be rolled back.
4. **Given** a provider with no rollback (Cloudflare Pages, a command target without `rollbackArgv`), **When** I roll back, **Then** the rollback row fails and says why, and the live deploy is unchanged.

### User Story 3 - Point a domain at the deploy (Priority: P2)

I add a domain (`app.example.com`) to a target. The CNAME in the Cloudflare zone that holds it is created, or updated if it exists, to point at the deploy's host. I can check whether the name reaches it yet.

**Why this priority**: it is needed once a host works, but a deploy is useful without it.

**Independent Test**: with a fake Cloudflare API, `addDomain` lists zones, picks the zone that holds the name, and creates the CNAME; a second call updates it.

**Acceptance Scenarios**:

1. **Given** an environment with `CLOUDFLARE_API_TOKEN` set, **When** I add `app.example.com` pointing at `x.vercel.app`, **Then** the CNAME is created in the `example.com` zone, and the token is sent only in the Authorization header.
2. **Given** no token for that environment, **When** I add a domain, **Then** I am told which secret is missing, and no request is sent.
3. **Given** the name does not reach the target yet, **When** I check, **Then** the answer says so, and reports what the name resolves to.

### User Story 4 - Cut a release with a changelog (Priority: P2)

I preview a patch, minor or major release. The preview shows the version, the commits since the last tag grouped by type, and the roadmap items I checked since then. Cutting it writes `package.json` and `CHANGELOG.md`, commits them, and tags the commit.

**Why this priority**: releases are routine once deploys work, and the changelog is most of the labour.

**Independent Test**: in a repo tagged `v1.0.0` with a `feat` and a `fix` commit, `planRelease(…, "minor")` returns `1.1.0` with both commits grouped; `cutRelease` leaves `package.json` at `1.1.0`, a `chore(release): v1.1.0` commit, and an annotated `v1.1.0` tag on it.

**Acceptance Scenarios**:

1. **Given** commits since the last tag, **When** I preview, **Then** nothing is written.
2. **Given** a dirty working tree, **When** I cut, **Then** it refuses, and says to commit or stash first.
3. **Given** the tag already exists, **When** I cut, **Then** it refuses and changes nothing.
4. **Given** a commit fails after the files were written, **When** I cut, **Then** the two files are put back.

### Edge Cases

- A secret value that appears in the CLI output is redacted before the log tail is saved (values of four characters or more).
- Only one deploy runs per target at a time; a second run is refused until the first finishes.
- A daemon restart while a deploy is queued or running marks it `failed` with "interrupted", so no row stays "running" forever.
- A target's environment name is a short lowercase slug; a target URL must be https.
- A command target's argv is an array of strings, never a shell line; `{id}` in `rollbackArgv` is replaced by the earlier deploy's handle and nothing else.
- A repo with no tag yet: the changelog covers up to 300 commits and says so as a warning.
- A `ROADMAP.md` that does not exist, or a lane change, does not block a release.

## Requirements

### Functional Requirements

- **FR-001**: Deploy providers MUST be `cloudflare` (wrangler, Workers or Pages from the config file), `vercel` (vercel CLI, `--prod` for prod), `fly` (flyctl deploy; `flyctl releases rollback` for rollback) and `command` (the user's argv, never detected from files).
- **FR-002**: Providers MUST run their CLI as an argv array, in the workspace folder. Secrets MUST reach the child process environment only.
- **FR-003**: Deploy targets (`deploy_targets`) MUST be one per workspace and environment, with a provider, a config JSON and a URL.
- **FR-004**: Deploys (`deploys`) MUST record status (queued, running, succeeded, failed), git sha, package version, URL, the provider's deploy handle, a redacted log tail and start and finish times. A `kind` column distinguishes a deploy from a rollback.
- **FR-005**: `runDeploy(targetId)` MUST return at once with a queued row and run the job in the background, streaming output into the log tail.
- **FR-006**: `rollbackDeploy(deployId)` MUST accept only the live deploy, and MUST roll back to the newest earlier successful deploy with a different artifact.
- **FR-007**: Domains MUST use the Cloudflare DNS REST API with fetch. The token MUST come from the secrets for the environment and MUST NOT be logged or returned.
- **FR-008**: Propagation MUST be checked through DNS over HTTPS, and a proxied record (which answers with addresses) MUST NOT be reported as broken.
- **FR-009**: `planRelease(root, bump)` MUST NOT write anything. `cutRelease(root, bump)` MUST refuse a dirty tree and an existing tag, and MUST restore its files if the commit fails.
- **FR-010**: The changelog MUST group conventional commits (feat, fix, perf/refactor, other, breaking), drop merges and release commits, and list the roadmap items checked since the last tag.
- **FR-011**: Secrets MUST be supplied through an injectable `envProvider` (default `{}`), set with `setEnvProvider`. This feature does not import the secrets store.
- **FR-012**: Routes, CLI and UI MUST exist as described in the plan. Registration in `server.ts` and the CLI index is done by the parent.

### Key Entities

- **Deploy target**: a workspace, an environment, a provider, its config (dir, project, app, scope, branch, configFile, argv, rollbackArgv) and its URL.
- **Deploy**: one attempt (deploy or rollback) against a target, with its outcome.
- **Release plan**: the last tag, the current and next version, the commits and roadmap items, the changelog section and any warnings.

## Success Criteria

- **SC-001**: A dev deploy with a command target goes from a Deploy click to a live URL on the card with no other step.
- **SC-002**: A rollback restores the previous artifact through the provider's own mechanism, and the history shows it.
- **SC-003**: No secret value appears in argv, the log tail, the API response or the test output.
- **SC-004**: A release can be previewed and cut from the CLI or the dialog, and its tag points at the commit that holds the version bump.

## Assumptions

- Provider CLIs (`wrangler`, `vercel`, `flyctl`) are installed and authenticated by the user, or their tokens are in the environment's secrets. Nothing installs them.
- The provider argument shapes are the ones current at writing (`wrangler rollback <version> --yes`, `vercel rollback <url> --yes`, `flyctl releases rollback <version>`). The Fly form was not checked against a live flyctl here and needs confirming.
- Cloudflare Pages has no rollback command in wrangler; rolling back a Pages target is a dashboard action, and the feature says so instead of faking it.
- A legacy `deploys` table from before this spec may exist in a user's database with other columns (spec 030 left it orphaned). The store checks its columns and, if it is not the new table, uses `deploy_runs` for history and never touches the old one.
- Releases write to the local repo only. Pushing the commit and tag is left to the user.
- Deploy and release history is local to the daemon's database; logs are kept as a tail, not in full.
