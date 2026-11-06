# Feature Specification: Templates and scaffolding

**Feature**: `102-app-scaffolding`
**Status**: Implemented
**Input**: "New app" recipes offered from the home screen: scaffold into an empty folder, git init, install, seed AGENTS.md, open a session with a starter prompt.

## User Scenarios & Testing

### User Story 1 - New app from a recipe (Priority: P1)
I pick a recipe (Next.js, Hono API, Vite + React, Expo), choose an empty folder, and get a working project, a git repo, installed dependencies, an AGENTS.md, and a session started with the recipe's starter prompt.

**Acceptance**: a non-empty target is refused before anything runs; nothing is written outside the target; the generator runs without prompts.

### User Story 2 - My own recipes (Priority: P2)
Recipes are data. I can add one (name, generator command, install command, conventions, starter prompt); it is stored in the trb home, never in a workspace.

## Requirements
- A recipe's commands are argument lists run without a shell, with the target folder as the working directory; the generator is told to use `.` as its target.
- The target must be an absolute path that is empty (or does not exist and has an existing parent), and not a filesystem root or the user's home.
- The run is a background job with a log tail the UI polls; steps: folder, generate, git init, install, seed, register.
- Generator and git calls go through one replaceable runner so tests never touch the network.
