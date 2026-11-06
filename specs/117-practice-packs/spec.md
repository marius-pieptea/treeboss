# Feature Specification: Practice packs

**Feature**: `117-practice-packs`
**Status**: Implemented
**Input**: Maintainability rule sets (KISS, YAGNI, smart vs. dumb components, small units, feature folders, strict types, test the logic, design tokens, basic accessibility, ponytail, and for marketing pages CRO, copywriting and SEO) that the operator switches on per workspace. An enabled pack tells every agent its rules, and where a mechanical check exists it is checked after each treeboss turn.

## User Scenarios & Testing

### User Story 1 - Tell every agent the rules of a pack (Priority: P1)

I turn on `small-units` for a workspace. Its rules are written into a managed block of AGENTS.md, mirrored into CLAUDE.md, so Codex and Claude both read them. My own text and the memory block are never touched.

**Why this priority**: it is the reason packs exist: the rules reach the agents before they write code.

**Independent Test**: enable a pack, read AGENTS.md and CLAUDE.md, and see the pack's heading and rules between the practices markers, with the memory block byte for byte as before. Disable it: the block is gone and the file is as it was.

**Acceptance Scenarios**:

1. **Given** a workspace with hand-written AGENTS.md text and memory rules, **When** I enable `kiss`, **Then** the new block is appended and everything else is unchanged.
2. **Given** `kiss` is on, **When** I enable it again, **Then** the files are byte-for-byte the same.
3. **Given** the last pack is turned off, **When** the file held only the block, **Then** the file is removed.

### User Story 2 - Have the gate catch violations of enabled packs (Priority: P1)

In treeboss mode, after each turn the gate runs the checks of the enabled packs on the files that turn changed. A violation goes back to the agent in the same fix turn as the existing rules, labelled with its pack, and the same attempt cap applies.

**Independent Test**: enable `small-units` with a 10-line file limit, have a turn write a 12-line file: the fix turn names `[small-units] <file>`; the next turn that brings the file under the limit passes.

**Acceptance Scenarios**:

1. **Given** no pack enabled, **When** a turn changes files, **Then** the gate runs no practice check and reads no file for them.
2. **Given** an enabled pack and a violation it finds, **When** the turn ends, **Then** the fix turn lists it with the pack's id.

### User Story 3 - Check the repo on demand (Priority: P2)

From the web panel's "Check now", from `trb practices check`, or from `POST /api/workspaces/:id/practices/check`, I get the findings of the enabled packs over the whole repo. In the CLI, without `--all`, the check covers only the uncommitted files.

**Acceptance Scenarios**:

1. **Given** an enabled pack with a violation, **When** I run `trb practices check --all`, **Then** the finding is printed with its file and line and the command exits 1.
2. **Given** a file path that leaves the workspace, **When** the check is requested, **Then** it is refused.

### User Story 4 - Own the thresholds and the custom packs (Priority: P2)

I set the file and function line limits for a workspace. I add a custom pack in `<TRB home>/practices.json` (or through the routes): its rules go into the block when it is on, and deleting it switches it off where it was on.

### Edge Cases

- A damaged practices block (a marker missing or repeated) is refused, not guessed at.
- A `practices.json` that does not parse makes the catalog refuse, and the gate treats that as no findings instead of failing the turn.
- Checks are heuristics on text: strings and comments are blanked first, but regex literals are not recognised.
- A repo that is not a git repository has no file list, so `check` asks for the files.
- Custom packs carry rules only; they have no mechanical checks.

## Requirements

### Functional Requirements

- **FR-001**: The built-in packs MUST be data (`src/practices/packs.ts`), at most eight rules each. Each mechanical check MUST belong to exactly one built-in pack.
- **FR-002**: Enabled packs MUST be stored per workspace in a table created lazily; `src/db.ts` MUST NOT change.
- **FR-003**: Enabling or disabling MUST rewrite only the practices block (`<!-- trb:practices:start -->` ... `<!-- trb:practices:end -->`) in AGENTS.md, mirrored into CLAUDE.md under the memory store's mirroring rule. It MUST be idempotent and MUST NOT change the memory block.
- **FR-004**: A custom pack MUST be validated (id, title, applies-to stacks, 1 to 8 rules, no comment markers) before it is saved.
- **FR-005**: The checks MUST be: file length, function length, `any` and non-null `!` in TypeScript, a presentational component that fetches or imports a data module (a container that passes its own fetched data to a child component is skipped), a raw hex or rgb color outside the tokens file, and an `<img>` without `alt`. Thresholds MUST be configurable per workspace.
- **FR-005a**: The marketing packs (`cro`, `copywriting`, `seo`, all for `web`) MUST add these checks: `banned-words` (ban-list words in copy, not in identifiers or comments), `generic-cta` (button or link text of exactly Submit, Click here, Learn more, Read more or Go), `seo-meta` (a Next.js `app/**/page.tsx` with no `metadata` or `generateMetadata` export, and an .html file with no `<title>` or meta description), `multiple-h1` (more than one `<h1>` in a page file) and `seo-link-text` (a link whose text is `click here` or `here`). They are heuristics. The ban list is fixed, with no per-workspace override, because thresholds are numeric only.
- **FR-005b**: The checks MUST read template files as well as code: Twig, Blade (`.blade.php`), ERB (`.erb`, `.html.erb`), Jinja (`.jinja`, `.jinja2`, `.j2`), Nunjucks (`.njk`), Liquid, Handlebars, Mustache, Go templates (`.tmpl`, `.gohtml`), PHP (its HTML parts only), Vue and Svelte (their template part for the copy checks), and Astro. The template syntax (`{{ }}`, `{{{ }}}`, `{!! !!}`, `{% %}`, `{# #}`, `<% %>`, `<?php ?>`, Blade `@directives`, and Svelte or Astro `{expressions}`) is blanked before any copy, link, alt, color or SEO text is read, so it is never flagged; code blocks (`<script>`, `<style>`, the Astro frontmatter) are not copy. `banned-words`, `generic-cta`, `seo-link-text`, `img-alt`, `multiple-h1` and `raw-color` read templates; `function-length` and `no-any` stay TypeScript-only; `presentational-data` reads `.vue` and `.svelte` components as it reads `.tsx`.
- **FR-005c**: `seo-meta` on a template page MUST be covered when the layout it names defines a `<title>` and a meta description. The layout comes from `{% extends %}` (Twig, Jinja), `@extends` (Blade), an imported `<Layout>` component (Astro), or, for an ERB view that sets `content_for :title`, `layouts/application`. A layout found in the usual template directories is read; a layout that is not found, or that extends another, is not judged. A head that carries template output may get its title or description from the template, so a missing one there is not reported. A partial (a template that is neither a document nor a page) is not judged.
- **FR-005d**: A file of the project's main stack (the most common source or template extension) that no enabled check reads MUST be returned as `skipped` (`{ check: null, reason }`, with the reason saying it is not checked mechanically and to rely on the AGENTS.md rules), by `checkFiles`, `practiceReport` and the check route. `practiceFindings` keeps its return type, so the gate is unchanged.
- **FR-009**: A pack MAY name `skills` (built-in or custom). Each renders in the block as `Use the X skill if available.` after the pack's rules. A pack without `skills` renders as before, and a custom pack in practices.json without `skills` keeps its old shape.
- **FR-006**: The gate MUST run the enabled packs' checks on the turn's changed files, in treeboss mode only, and MUST be a no-op when no pack is enabled. Findings MUST join the existing fix turn and its attempt cap.
- **FR-007**: `practiceFindings(root, changedFiles)` MUST be exported for verify and the lab.
- **FR-008**: A path given to the check route MUST be inside the workspace.

### Key Entities

- **Pack**: id, title, summary, applies-to stacks, rules, optional skills and checks. Built-in or custom.
- **Practice settings**: workspace, enabled pack ids, thresholds.
- **Finding**: pack id, check, file, optional line, message.

## Success Criteria

- **SC-001**: `bun test tests/practices.test.ts` passes, with the gate, treeboss and memory suites.
- **SC-002**: `bun run typecheck` passes.
- **SC-003**: With no pack enabled, a treeboss turn gives the same gate outcome as before this feature.

## Assumptions

- Stack tags (`web`, `mobile`, `api`, `any`) describe a pack; they do not filter what runs. The operator picks the packs.
- The mechanical checks are heuristics; a finding is a prompt for the agent to look, not a proof.
