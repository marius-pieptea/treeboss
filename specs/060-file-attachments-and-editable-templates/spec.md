# Feature Specification: Attach any file, and editable templates

**Feature**: `060-file-attachments-and-editable-templates`
**Status**: Implemented
**Input**: The composer attaches more than images: PDFs, HTML, text and code, Word documents and zip archives, several at once. The app-scaffolding recipes stop being hardcoded: they are ordinary entries in a Settings page where each can be edited, reset, duplicated, reordered and deleted.

## User Scenarios & Testing

### User Story 1 - Attach files of any common kind (Priority: P1)

I paste, drop, or pick (the `+` menu, "Attach files…") one or many files. Each becomes a chip with its name, size and a remove button. When I send, every engine receives the content as text in the `# Attached context` block, plus the absolute path of what is stored, so an engine with file tools can read more.

**Independent Test**: `POST /api/context/files { name, data }` stores a file; `POST /api/context/resolve` with `{kind:"upload", value:<id>}` returns the block.

**Acceptance Scenarios**:

1. **Given** a text, code, markdown, json or csv file, **When** sent, **Then** it is inlined up to the existing per-chip and total caps and the original's path is named.
2. **Given** an HTML file, **Then** the block carries the page's text (scripts and styles removed), the HTML source, and the path of a saved text-only version.
3. **Given** a PDF or a .docx, **Then** the extracted text is inlined up to the cap, the full extracted text is saved and its path given, and the original's path is given.
4. **Given** a zip, **Then** it is unpacked into a scratch folder under the trb home and the block carries the file tree and the unpacked path; only small text files (README and manifests first) are inlined, within a budget.
5. **Given** a file that cannot be read (damaged PDF, a corrupt zip), **Then** its chip becomes one line saying why. The send still goes.

### User Story 2 - Edit the New app templates (Priority: P1)

Settings has a **Templates** page. The four built-ins (Next.js, Hono, Vite + React, Expo) are listed as ordinary entries. I edit one with a form (name, description, tag, icon, generator command, post-generate steps, rules for AGENTS.md, intro, starter prompt), add my own, duplicate, reorder and delete. A built-in has **Reset to default**; the page has **Restore missing defaults**. The New app dialog on Home lists exactly these.

**Independent Test**: `GET/POST/PUT/DELETE /api/scaffold/recipes[/:id]`, `POST …/:id/reset`, `…/restore-defaults`, `…/reorder`.

**Acceptance Scenarios**:

1. **Given** a fresh home, **Then** the four defaults are seeded once into `recipes.json` and nothing is locked.
2. **Given** I delete a default, **Then** it stays deleted until I restore it.
3. **Given** a generator command with `&&`, a pipe, `$(…)` or `sh -c`, **Then** saving is refused with a message, because commands run as an argument list with no shell.
4. **Given** any template, **Then** the target-folder checks (absolute, empty, not a link, not the home folder) still run before anything is written.

### Edge Cases

- A file whose name claims one type and whose bytes are another is refused (a `.pdf` that is not a PDF, an `.exe`), or typed by its bytes.
- Hostile zips: `../` and absolute entry names, drive letters, backslash escapes, symlink and device entries, encrypted entries, duplicate entries, an entry that lies about its size, a bomb (huge ratio), too many entries, deep paths, nested archives. Each is refused or neutralised; none writes outside the scratch folder.
- A stored file removed by the cleanup sweep while a session still names it is a "no longer stored" note.
- A hand-edited, unreadable `recipes.json` is copied to `recipes.json.bak` before the defaults are re-seeded.

## Requirements

### Attachments

- **FR-001**: Type is decided by magic bytes, then extension, then a UTF-8 sniff; the browser's claimed type is never trusted. Supported: png/jpeg/gif/webp (existing image store), pdf, docx, zip, html, and any UTF-8 text or code. Unsupported (other binaries, .doc, .xlsx, .pptx) is refused at upload with a message.
- **FR-002**: Caps: 25 MB per file, 75 MB of files per message, 12 chips per message (existing), the existing 12,000 characters per chip and 48,000 per message in the prompt. The web checks the same limits before uploading.
- **FR-003**: Files are stored under `<trb home>/context-files/<id>/` (`original/<safe name>`, `meta.json`, derived `extracted.txt` and `unpacked/`), mode 0600/0700, never in a repository. The stored name is the last path segment, sanitised; the id shape is validated so it can never be a path.
- **FR-004**: Zip extraction runs in our own reader over `node:zlib`: entry count ≤ 2,000; per-entry ≤ 50 MB; total ≤ 150 MB; compression ratio over 200:1 on entries over 1 MB is a bomb; path depth ≤ 16; inflation is capped at the declared size so a lying header cannot grow; symlinks, devices, encrypted and ZIP64 entries are refused; nested archives are written as plain files and never opened; every target path is re-checked to stay inside the scratch folder and not to cross a link; extracted files are 0600 with no executable bits.
- **FR-005**: Parsing a file never fails the send (see story 1, scenario 5). A PDF read is bounded to 30 seconds.
- **FR-006**: Cleanup: stored entries (this folder and `context-images`) are deleted when not used for 30 days ("used" is upload or being attached to a message). The sweep runs at most hourly, piggybacked on an upload. Files are not removed when a session ends: a session may be resumed later.

### Templates

- **FR-007**: `recipes.json` holds all recipes in display order as `{version: 2, seeded: [...], recipes: [...]}`. Defaults are seeded once (tracked in `seeded`), a default added in a later release is appended, and one the operator deleted is not brought back except by "Restore missing defaults". A version 1 file (an array of the operator's own recipes) is migrated, defaults first.
- **FR-008**: A recipe is `{id, name, description, generate: argv, steps: argv[], conventions[], intro, starterPrompt, icon, tag, builtinId?}`. `builtinId` links an entry to the default it came from; only those can be reset. `install` (version 1) is accepted on input and becomes the first step.
- **FR-009**: Validation on save: the generator is a non-empty argv; the program name has no whitespace or shell characters; no entry is a shell operator (`&&`, `||`, `;`, `|`, `>`, `<`, `&`); no argument uses `$(`, backticks or `${`; a shell invoked with `-c` is refused; steps follow the same rules; the id is lowercase letters, digits and dashes and is not `reorder` or `restore-defaults`.
- **FR-010**: Commands run exactly as written, without a shell, in the new folder (unchanged from 102). The editor shows the parsed argument list under each command so what runs is visible.
- **FR-011**: There is no `trb` CLI for recipes today, so there is no CLI parity to keep; the HTTP routes are the interface.

## Dependency note

PDF text extraction needs a PDF parser. Writing one is not reasonable; the choice is **`unpdf` 1.8.1** (MIT, UnJS): a thin wrapper around a serverless build of Mozilla's pdf.js, pure JavaScript, no native modules, runs under Bun, ~2.5 MB on disk, one runtime dependency added to the repo. It is loaded lazily on the first PDF. Zip and docx need no dependency: a docx is a zip with `word/document.xml`, and the zip reader is small (`src/context/zip.ts`) and ours, which is what lets every limit above be enforced by us instead of trusted to a library.

## Unverified

Whether each real engine can open the absolute paths in the block was not tested with real engines (only with the scripted one). The text that matters (extracted text, tree, inlined small files) is in the prompt itself, so an engine with no file tools still has it; the paths are for engines that can read more. Paths outside the working directory may need a permission grant in engines that sandbox reads (codex read-only sandbox allows reads; claude asks or is allowed per its permission mode).
