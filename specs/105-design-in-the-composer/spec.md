# Feature Specification: Design turns in the composer

**Feature**: `105-design-in-the-composer`
**Status**: Implemented
**Input**: "Shouldn't design system generation be part of the composer and thread, perhaps a new mode, instead of a decoupled modal?"

## Decision

Design is a kind of task, not a permission level, so it is not a fourth mode next to Build, Plan and Ask (those decide what the agent may do). It is a chip on the composer, like the goal chip, and a `/design` command. A design turn always runs in Build mode.

## Behaviour
- `/design` alone sets the chip for a brief. `/design <text>` sends a brief, `/design https://…` a reference, `/design code|wire|review [notes]` the others, `/design --quick …` skips the brainstorm. A brief may span lines.
- The composer's + menu has *Design system…*. The chip shows the kind and brainstorm, both changeable, and clears with ×.
- The composer sends `design: { kind, brainstorm }` on `POST /api/sessions` or `POST /api/sessions/:id/send`. A route module that runs first builds the prompt: the operator's words, then `<!-- trb:instructions <label> -->`, then the instructions. The turn is forced to Build mode, and a new session gets a design title. Context chips are folded in after, in front.
- The thread shows only the operator's words, plus a tag that unfolds the instructions.
- A thread with a design turn shows the directions page as a scaled, sandboxed card, with *Compare* to open the Design view.
- The Design view's buttons and the palette (*Design: brainstorm a design system…*, *Design: review the UI…*) open a new session with the chip set. The modal is gone. `POST /api/design/:root/start` and `trb design start` stay, and use the same prompt builder.
