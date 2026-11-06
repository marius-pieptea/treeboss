# Feature Specification: Mobile pipeline (Expo and EAS)

**Feature**: `115-mobile-pipeline`
**Status**: Implemented
**Input**: An Expo app in a workspace can be detected, built on EAS, submitted to TestFlight or the Play internal track, updated over the air, previewed in Expo Go, and checked for store-listing problems, from the web UI, the CLI or the HTTP API.

## User Scenarios & Testing

### User Story 1 - See the app TreeBoss found (Priority: P1)

I open the mobile panel of a workspace. It says which Expo app is there: its name, Expo SDK, platforms, bundle id, Android package and the build profiles in `eas.json`. If the project is not Expo, it says so and nothing else is offered.

**Why this priority**: every other action depends on knowing the project is an Expo app and what it targets.

**Independent Test**: `GET /api/mobile/:root` on a project with `package.json` (expo dependency), `app.json` and `eas.json` returns `detect.isExpo: true`, both platforms, the bundle id and the profiles. A project without those files returns `isExpo: false`.

**Acceptance Scenarios**:

1. **Given** an Expo project with `app.json` and `eas.json`, **When** I open the panel, **Then** I see the bundle id, the Android package and each build profile.
2. **Given** a project with `app.config.ts`, **When** I open the panel, **Then** the identifiers come from a text read and the panel says the config was not run.
3. **Given** a plain React Native project, **When** I open the panel, **Then** it reads "Not an Expo app".

### User Story 2 - Build and submit from TreeBoss (Priority: P1)

I queue iOS, Android or both builds on EAS for a profile. The build returns at once and its status (queued, in progress, finished, errored) updates until it is done. When a build finishes I can download it, and I can submit the latest finished build to TestFlight (iOS) or the Play internal track (Android) with a submit profile.

**Why this priority**: builds and store submission are the work the pipeline exists for.

**Independent Test**: with `EXPO_TOKEN` in the workspace's secrets, `POST /api/mobile/:root/builds` queues builds, and the poller moves an in-flight build to `finished` with an artifact URL after `build:view` reports it.

**Acceptance Scenarios**:

1. **Given** no `EXPO_TOKEN`, **When** I queue a build, **Then** nothing is spawned and the error says where to add the token.
2. **Given** a queued build, **When** EAS reports it finished, **Then** the list shows the status word, the version and a download link without a reload.
3. **Given** a finished iOS build, **When** I submit the latest iOS build with a submit profile, **Then** the submission is recorded with its build, and a failure is recorded too, with the CLI's last lines.

### User Story 3 - Update over the air and preview on a phone (Priority: P2)

I publish a JavaScript update to a branch with a message. I also open a preview: an `exp://` tunnel URL from `expo start --tunnel` with a QR code, so I can open the app in Expo Go on a phone that is not on my network.

**Independent Test**: `POST /api/mobile/:root/update` runs `eas update --branch --message`; `GET /api/mobile/:root/preview` returns `url` and an SVG `svg`.

**Acceptance Scenarios**:

1. **Given** a branch and a message, **When** I publish an update, **Then** the CLI's closing lines are shown.
2. **Given** a running preview, **When** I ask for the preview again, **Then** the same URL comes back with `started: false`.

### User Story 4 - Store listing that meets the limits (Priority: P2)

`store/metadata.json` holds the listing. TreeBoss checks it: name and subtitle at most 30 characters, keywords at most 100, a description, and an https privacy URL. Every problem is listed, not just the first.

**Independent Test**: `checkStoreMetadata` on a 31-character name returns an issue for `name` with the limit in its text.

### User Story 5 - Expo checks in verification (Priority: P3)

For an Expo project, verification runs `tsc --noEmit` when the project has a tsconfig and no typecheck script. It runs `npx expo-doctor` last, only when the project declares `expo-doctor`.

### Edge Cases

- A dynamic `app.config.*` is read as text: computed identifiers are not seen, and the panel says so.
- A broken `app.json` or `eas.json` is reported as a note, not a crash.
- `EXPO_TOKEN` missing: the poller skips the workspace; cloud actions refuse with a message.
- The EAS CLI prints text before its JSON: the JSON part is still read.
- The EAS CLI is not on PATH: `npx --yes eas-cli` is used.
- A poll for one build fails (network, unknown build): the other builds are still polled.
- The Expo tunnel does not print a URL within two minutes: the process is stopped and the error says so.

## Requirements

### Functional Requirements

- **FR-001**: The daemon MUST detect an Expo project from `expo` in package.json, `expo` in app.json, an `app.config.*` file or an `eas.json`, and MUST read the platforms, bundle id, Android package, SDK range and eas.json profiles.
- **FR-002**: App configs MUST NOT be executed. Identifiers in a dynamic config MUST be read as text and the result MUST say so.
- **FR-003**: Every EAS call MUST be an argv array run without a shell. `eas` is used when on PATH, otherwise `npx --yes eas-cli`.
- **FR-004**: Every cloud EAS call (build, build:list, build:view, submit, update) MUST refuse before spawning when `EXPO_TOKEN` is not in the workspace's environment, with a message that says where to add it.
- **FR-005**: Builds MUST be queued with `--no-wait` and recorded in `mobile_builds`. The poller MUST refresh in-flight builds with `build:view`.
- **FR-006**: Submissions MUST be `eas submit --platform X --latest --profile X --non-interactive` and MUST be recorded in `mobile_submissions` with success or failure.
- **FR-007**: The store listing MUST be checked against name ≤ 30, subtitle ≤ 30, keywords ≤ 100 characters, a non-empty description and an https privacy URL, and every issue MUST be returned.
- **FR-008**: The Expo Go preview MUST run `expo start --tunnel`, one process per project, and return the `exp://` URL with a QR code as SVG.
- **FR-009**: Expo verification MUST add `tsc --noEmit` when no typecheck script exists, and `npx expo-doctor` as `doctor` only when the project declares `expo-doctor`.
- **FR-010**: The environment for EAS calls MUST come from an injectable provider. The default provides nothing.

### Key Entities

- **Mobile build**: a workspace, a platform, a profile, the EAS build id, the EAS status, an artifact URL, a version and a build number.
- **Mobile submission**: a workspace, a platform, a submit profile, the build it sent (when known), a status and the CLI's detail.
- **Store listing**: name, subtitle, keywords, description, privacy URL (`store/metadata.json`).

## Success Criteria

- **SC-001**: `bun test tests/mobile.test.ts` passes without network access, `EXPO_TOKEN` or an EAS account.
- **SC-002**: No EAS or Expo argument is built from a shell string; every user-supplied profile, branch and id is checked before it reaches argv.
- **SC-003**: An Expo project with no other setup shows its platforms, identifiers and profiles in the panel.

## Assumptions

- EAS is driven through its CLI (`eas build --no-wait --json`, `eas build:view --json`, `eas submit --latest`, `eas update`). The package `eas-cli` is fetched by npx when it is not installed.
- The secrets slice supplies `EXPO_TOKEN` through the env provider. The daemon sets it at start (`src/daemon/lifecycle.ts`). Without `EXPO_TOKEN` in the environment, cloud actions refuse with the missing-token message.
- The app binaries stay with EAS. TreeBoss stores the EAS URL, not the file.
