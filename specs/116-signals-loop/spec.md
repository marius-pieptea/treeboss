# Feature Specification: Signals loop (operate → grow)

**Feature**: `116-signals-loop`
**Status**: Implemented
**Input**: What the running product reports back (production errors, product metrics, what users send from the site) lands in one inbox per project, and each signal becomes a Lab finding, a roadmap item or a fix session with one action.

## User Scenarios & Testing

### User Story 1 - See what production is telling me (Priority: P1)

I open the Signals inbox for a project. It lists unresolved Sentry issues and feedback, most severe and most frequent first, and shows the PostHog numbers as tiles above the list.

**Why this priority**: without this the operate half of the loop is invisible; everything else reads from it.

**Independent Test**: with Sentry configured and a stubbed Sentry API, `trb signals sync` upserts the unresolved issues and `trb signals ls` lists them with severity and count.

**Acceptance Scenarios**:

1. **Given** Sentry has three unresolved issues, **When** I sync, **Then** three error signals exist, each with severity (fatal → critical, error → high, warning → medium, other → low), count, and link.
2. **Given** I sync again, **When** the counts changed, **Then** the same rows update in place and nothing is duplicated.
3. **Given** I ignored an issue, **When** the next sync brings it back, **Then** it stays ignored.
4. **Given** PostHog is configured, **When** I sync, **Then** the tiles show active users over 7 and 30 days and the counts of the named events over 7 days.

### User Story 2 - Turn a signal into work in one step (Priority: P1)

A new signal has four actions: write it as a Lab finding, add it to the roadmap's Next lane, start a fix session with the signal as its prompt, or ignore it.

**Independent Test**: `trb signals triage <id> to_roadmap` adds an item to Next and the signal shows as linked to that item id.

**Acceptance Scenarios**:

1. **Given** a new signal, **When** I choose to_finding, **Then** `lab/findings/sig-….md` exists, Lab reads it as a new finding, and the signal links to its path.
2. **Given** a new signal, **When** I choose to_roadmap, **Then** the item is in Next with the signal's title and link in its description, and the signal links to the item id.
3. **Given** a new signal, **When** I choose to_session, **Then** a build session starts with the signal's details in its prompt, and the signal is marked working with the session id in its meta.
4. **Given** I choose to_finding twice for the same signal, **Then** the same file is kept, not duplicated.

### User Story 3 - Hear from users without a form tool (Priority: P2)

A visitor of the product's site sends feedback through a small widget. It is stored as a feedback signal, and the same message from the same page counts up rather than repeating.

**Independent Test**: POST `{message}` to the workspace's intake URL with its token returns 201, and the message appears in the inbox.

**Acceptance Scenarios**:

1. **Given** the widget is on my site, **When** a visitor sends a message with a rating of 1, **Then** a high-severity feedback signal exists with the page and the rating.
2. **Given** the token was rotated, **When** the old token is used, **Then** the intake answers 404.
3. **Given** a peer sends more than 30 messages in a minute, **When** it sends another, **Then** it gets 429 and other peers are not affected.
4. **Given** a body over 16 KB, **Then** it gets 413 and nothing is stored.

### User Story 4 - Let an agent propose what to build next (Priority: P3)

An agent clusters the new signals into groups and proposes one roadmap item per group, citing the signals and counts. It changes nothing itself.

**Acceptance Scenarios**:

1. **Given** five new signals, **When** I ask for the auto-triage prompt, **Then** it lists the five with their ids and forbids file changes and session starts.

### Edge Cases

- A source with no settings is "not set up": nothing is fetched and the inbox says so.
- A source whose request fails is reported in the sync result; the other sources still sync.
- Event names that could break a query are dropped, not quoted in.
- Tokens and keys never appear in an error message or a log line.
- A signal id that does not exist is refused; an unknown triage action changes nothing.

## Requirements

### Functional Requirements

- **FR-001**: Signals MUST be stored per workspace in table `signals`, unique on (workspace, source, external id). Sync MUST update rows in place and MUST NOT change a row's status or link.
- **FR-002**: Sentry MUST be read through its REST API with a bearer token, for unresolved issues of one project. Its settings come from the environment provider, never from a literal.
- **FR-003**: PostHog MUST be read through its HogQL query API for active users over 7 and 30 days and optional named-event counts over 7 days. Values MUST be stored as metric signals with the value in `meta`.
- **FR-004**: Each source MUST be injectable (fetch) so tests run without a network. A failing source MUST NOT stop the others.
- **FR-005**: Feedback intake MUST be `POST /api/signals/feedback/:token`. It MUST be authenticated by the per-workspace token only, MUST answer CORS, MUST rate-limit per peer, and MUST cap the body at 16 KB and the message at 4,000 characters.
- **FR-006**: The feedback token MUST be per workspace and rotatable. Rotation MUST invalidate the old token at once.
- **FR-007**: `triageSignal` MUST support `to_finding`, `to_roadmap` (default lane Next), `to_session`, and `ignore`. Each MUST write through the owning module (lab findings, roadmap store, session manager).
- **FR-008**: `autoTriagePrompt` MUST list the new signals and MUST NOT ask the agent to change files or start sessions.
- **FR-009**: `syncSignals` MUST be exported for a scheduler. Its environment MUST be injectable; the default is empty, so nothing is read.
- **FR-010**: The inbox MUST use design tokens only.

### Key Entities

- **Signal**: source, kind (error, metric, feedback), external id, title, body, severity, count, url, meta, status (new, triaged, ignored, linked), linked ref, first and last seen.
- **Feedback token**: one per workspace; the only credential the public intake accepts.

## Success Criteria

- **SC-001**: One sync followed by one triage produces a Lab finding or a roadmap item with no other step.
- **SC-002**: A visitor's message reaches the inbox within one request, and an abusive peer is stopped at 30 per minute without touching the owner's routes.
- **SC-003**: No source credential appears in any response, error or stored row.

## Assumptions

- The secrets module supplies the `prod` environment (SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, POSTHOG_API_KEY, POSTHOG_PROJECT_ID, POSTHOG_HOST) through `envProvider`. Until it is wired, every source reads as not set up.
- A `signals_sync` schedule runs `syncSignals` on its cron (`src/autopilot/schedule.ts`). It can be added from the CLI (`trb schedule add --kind signals_sync`) and from the schedule editor.
- The public intake is reachable only where the daemon is reachable; remote-access policy is not changed here.
