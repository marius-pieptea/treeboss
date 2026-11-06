# Feature Specification: Design systems

**Feature**: `103-design-systems`
**Status**: Implemented
**Input**: "Add design systems next to templates so when we start a new project, the missing frontend layer for the agents is sorted too. Generate design systems, not just pick them."

## Why

Agents write UI from whatever they guess. Without a written contract every screen invents its own colors, type scale and spacing, and the reviewer cannot say what "on brand" means. A design system here is two files in the repository that every agent reads before UI work:

- `DESIGN.md` at the root: the contract in words. Personality, color roles, type scale, spacing, radius, elevation, motion, component rules, do and don't.
- `design/tokens.css`: the same decisions as CSS custom properties, named by one shared contract so any system can be swapped for another without touching components.

trb is a lens over those files, the same way it is over `ROADMAP.md`, `specs/` and `docs/`: nothing about a project's design is kept in the database, git keeps the history.

## User Scenarios & Testing

### User Story 1 - New app with a design system (Priority: P1)
In New app I pick a template and a design system. The project is created with `DESIGN.md` and `design/tokens.css`, AGENTS.md tells agents to follow them, and the starter prompt asks the agent to wire the tokens into the styling setup before building screens.

**Acceptance**: the files are in the first commit; choosing "None" writes nothing; an unknown design system is refused before anything runs.

### User Story 2 - A library of design systems (Priority: P1)
Settings → Design systems lists the systems New app offers, next to Templates. Each is a name, a description, a DESIGN.md and a tokens.css, all editable, with a live swatch preview. trb ships four original, brand-neutral systems; they can be edited, reset, deleted and restored like templates.

### User Story 3 - The Design view of a project (Priority: P1)
The Design view shows the project's DESIGN.md rendered, and its tokens as swatches (colors light and dark, fonts, radii). With no DESIGN.md it offers: apply one from the library, or generate one. Nothing is written until I click.

### User Story 4 - Generate a design system with an agent (Priority: P2)
From the Design view I start a session that writes DESIGN.md and design/tokens.css from:
- a **brief** (what the product is, who it is for, the feel),
- a **reference URL** (the agent studies it with its browser tools and derives an original system; it never copies logos, names or brand assets),
- the **codebase** (extract what the existing UI already implies, and list the drift).

### User Story 5 - Keep the UI on the system (Priority: P2)
- **Wire tokens**: a session that imports tokens.css into the app's global styles and maps the tokens into the styling setup in use (Tailwind v4 `@theme`, Tailwind v3 config, CSS modules, …).
- **Review UI**: a session that compares the running UI to DESIGN.md (screenshots through the browser tools when available, the code otherwise), lists violations with `file:line`, and fixes the clear-cut ones.

### User Story 6 - Keep a project's system (Priority: P3)
"Save to library" copies the project's DESIGN.md and tokens.css into the library under a new name, so a system generated for one project can start the next.

## Requirements
- The token contract (variable names) is fixed and documented in every shipped DESIGN.md; generation prompts require it. Extra tokens are allowed.
- Applying a system to a project that already has DESIGN.md or design/tokens.css requires an explicit overwrite.
- Workspace paths are fixed: `DESIGN.md` at the root and `design/tokens.css`. Writes refuse symlinks that lead out of the workspace.
- The library lives in `<trb home>/design-systems.json`, never in a workspace. Seeding, reset, delete and restore behave like templates.
- The AGENTS.md rule is added through project memory (it is a managed rule, visible and removable in Memory).
- Generation sessions are ordinary sessions in the workspace; trb adds only the prompt.

## Non-goals
- A visual token editor, Figma import, or component library generation.
- Shipping copies of real brands' design systems.
