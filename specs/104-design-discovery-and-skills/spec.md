# Feature Specification: Design discovery and built-in skills

**Feature**: `104-design-discovery-and-skills`
**Status**: Implemented; its start dialog is superseded by spec 105
**Input**: "Can I generate design systems using the agents with a brainstorm first, like open-design? Attach design skills, either a way to add them or bundled with the app."

## Why

Generating a design system from a one-line brief makes the agent guess the things that matter most: who the product is for, how it should feel, how dense it is. The result looks competent and generic. open-design (Apache-2.0) gets better results from three habits that we adapt here, credited in NOTICE:

1. **Discovery before building.** Ask only what would change the result (at most five questions, each with a recommended default so the answers can be sent unchanged), and show two or three distinct directions instead of one answer.
2. **Extract, never guess.** With a reference site, read real values out of its CSS rather than recalling a brand's colors from memory.
3. **Self-critique before finishing.** Score the work on philosophy, hierarchy, execution, specificity and restraint, fix anything below 3/5, and run an anti-generic checklist.

## User Scenarios & Testing

### User Story 1 - Brainstorm before a design system is written (Priority: P1)
From the Design view I generate from a brief (or a reference site) with **Brainstorm first** on (the default). Spec 105 moved starting into the composer. The Design view's buttons now open a new session with the design chip set, and Brainstorm first is a switch on that chip. The agent's first turn writes no design files. It asks up to five questions, each with a suggested answer, and writes `design/directions.html`: two or three differentiated directions side by side (palette, type, a sample card and button). The Design view shows that page. I answer in the session ("B, but warmer, and it is mostly used on phones"), and the next turn writes DESIGN.md and design/tokens.css for that direction and removes the directions page.

**Acceptance**: with Brainstorm off, the session writes the files in one turn as before; the directions page is shown sandboxed (no scripts, no access to the app's origin).

### User Story 2 - Better generation and review (Priority: P1)
Every generating session and Design review carries the anti-generic checklist and the five-dimension self-critique. A reference-site session extracts real values from the site's CSS and states the system back in one sentence before writing.

### User Story 3 - Design skills that ship with trb (Priority: P2)
trb ships three skills, written for trb: `design-discovery`, `design-critique` and `brand-extract`. They are seeded into the skill store once, enabled, and usable in any session ("make this page match DESIGN.md"). In Settings → Skills they are marked built-in and can be edited, reset to the shipped text, deleted and restored. A skill I already have with the same name is never overwritten.

### User Story 4 - Other design skills (Priority: P3)
The README lists recommended upstream design skills to add with the existing `trb skill import`, so their licenses stay with their own repositories.

## Requirements
- One source for the guidance: the session prompts and the shipped skills are built from the same text.
- The direction library is original to trb (genres and movements, not brands).
- Seeding happens when the daemon starts; a deleted built-in stays deleted until restored.

## Non-goals
- A question-form UI inside the chat (answers are typed as a normal reply).
- Bundling open-design's skills folder.
