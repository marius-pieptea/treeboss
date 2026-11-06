# Feature Specification: Target detection and REA readiness

**Feature**: `107-target-detection-rea-readiness`
**Status**: Implemented
**Input**: Investigations work out the target kind themselves, and treeboss checks and reports what REA needs (engines, JDK, Android tools) and passes their paths to REA

## User Scenarios & Testing

### User Story 1 - Investigations work out their own target kind (Priority: P1)

I create an investigation with a target (a URL, a bare domain, a path to an app, a binary, an APK or a folder) and leave the kind alone. The kind defaults to **auto**, and treeboss decides it from the target: a web address is `web`, an Electron app is `electron`, a native binary is `binary`, an APK is `android`, and anything else is `other` for REA to classify. The UI and the CLI say what was decided and why. If I pick a kind myself, my choice wins.

**Why this priority**: the operator should not have to know REA's vocabulary to start a run. A wrong kind sends the agent down the wrong path (browser capture for a binary, REA for a website), so the kind has to be right before the run starts.

**Independent Test**: `POST /api/evidence/:root/investigations` with a target and no kind returns the investigation with `target_kind` set and `kind_reason` naming the marker that decided it; with `target_kind: "electron"` the explicit kind is stored and `kind_reason` is null.

**Acceptance Scenarios**:

1. **Given** the target `https://example.com`, **When** I create an investigation with the kind left on auto, **Then** the kind is `web` and the reason is "http(s) URL".
2. **Given** a `.app` whose `Contents/Resources/app.asar` exists, **When** I create one with the kind on auto, **Then** the kind is `electron` and the reason names that file.
3. **Given** a `.app` with no Electron marker, **When** I create one with the kind on auto, **Then** the kind is `binary` and the reason names the executable from its `Info.plist`.
4. **Given** an investigation stored as `other` whose target has since become a known kind, **When** I run it, **Then** the run works the target as the kind detected now, and the stored kind and reason stay as they were.
5. **Given** I chose `android` for a target that looks like a web page, **When** I create it, **Then** the kind stays `android`: my choice wins over detection.

### User Story 2 - See what REA needs before a run fails (Priority: P1)

Treeboss checks whether REA can work on this machine: whether it can start, whether a native engine (Ghidra, Hopper or IDA) is installed, whether the JDK that engine needs is present, whether apktool and the pinned jadx-headless-mcp jar are there, and whether adb is there. Each gap is shown as a warning with the command that closes it. `trb doctor` shows the checks, and Settings > MCP > rea shows them with copyable fix commands and a **Check again** button.

**Why this priority**: a run that fails because Ghidra has no JDK looks like a broken agent. The operator needs the cause and the fix before the run, not after it.

**Independent Test**: on a machine with Ghidra installed and no JDK, `trb doctor` shows a warning for the JDK with the fix command, and the rea readiness report carries the same warning.

**Acceptance Scenarios**:

1. **Given** Ghidra is installed and no JDK 21 or newer is found, **When** I run `trb doctor`, **Then** a `rea:java` warning says Ghidra needs a JDK 21 and gives the install command.
2. **Given** no native engine is installed, **When** I open Settings > MCP > rea, **Then** a warning says binaries get strings and structure only, with `brew install ghidra`.
3. **Given** a warning in Settings > MCP > rea, **When** I press **Check again**, **Then** the deep check runs (REA's own doctor included) and the list refreshes.
4. **Given** the Engines page, **Then** it runs the shallow check only and never starts REA.

### User Story 3 - REA finds its engines without shell profile edits (Priority: P1)

When treeboss starts REA, it passes REA the absolute paths of the engines it found: Ghidra's install folder, a JDK home, apktool, adb, the jadx-headless-mcp jar and, on Linux, binwalk. I do not edit `.zshrc` to make them visible, and a value I set myself is never overwritten.

**Why this priority**: on macOS the JDK that Homebrew installs for Ghidra is keg-only, and the `java` on PATH is the system stub. Without these paths REA reports that its engines are missing even when they are installed.

**Independent Test**: with Ghidra installed under the Homebrew Cellar and `GHIDRA_INSTALL_DIR` unset, the env built for the REA server contains `GHIDRA_INSTALL_DIR` pointing at the install folder; with `GHIDRA_INSTALL_DIR` set by the operator, that variable is not in the env.

**Acceptance Scenarios**:

1. **Given** Ghidra and its JDK are installed by Homebrew and no variable is set, **When** REA starts, **Then** its environment carries `GHIDRA_INSTALL_DIR` and `JAVA_HOME` (the JDK home, not the PATH stub).
2. **Given** the operator has set `JAVA_HOME` in the environment, **When** REA starts, **Then** `JAVA_HOME` is not passed and the operator's value is used.
3. **Given** apktool is installed and the pinned jadx-headless-mcp 0.7.1 jar is under `~/.local/share/rea/jadx/0.7.1/`, **When** REA starts, **Then** its environment carries `REA_APKTOOL_COMMAND` and `REA_JADX_MCP_JAR` with those absolute paths.
4. **Given** nothing is installed for a variable, **Then** that variable is not passed at all.

### User Story 4 - REA's launcher is found when the desktop app has no Homebrew PATH (Priority: P2)

The desktop app, launched from the Dock, may not have Homebrew on its PATH. When `npx` is not on the daemon's PATH, treeboss finds it under `/opt/homebrew/bin` or `/usr/local/bin`, starts REA with that, and adds the directory that holds `npx` and `node` to REA's PATH. The readiness launcher line says where it was found.

**Why this priority**: without it the rea server does not start at all from a GUI launch, and nothing in the run says why.

**Independent Test**: with `npx` present only under `/opt/homebrew/bin` and absent from the daemon's PATH, the launcher check is `ok` and its text names that path; the env built for REA carries a PATH that includes `/opt/homebrew/bin`.

### Edge Cases

- What happens when the target path does not exist? Detection returns `other` with the reason "not found". The run preflight refuses it with the path reason (spec 106), and the investigation is still created.
- What happens when a bare name such as `notes.md` or `app.apk` is given? It is a file name, not a domain: the extension decides it, and a missing file is not read as a web address.
- What happens when a file cannot be read? Detection returns `other` with the reason "could not read it"; no error reaches the operator.
- What happens when a `.app` has an `Info.plist` in binary format, or its executable key lies past the read cap? The executable is found by its name (the binary named like the app) or as the only file in `Contents/MacOS`, else the reason says only "native macOS app".
- What happens when a universal Mach-O (`cafebabe`) is also the magic of a Java class? It is decided as `binary`, with the reason saying both.
- What happens when a folder holds a `package.json` that depends on `electron` only in a dev dependency? It is decided as `electron`, the same as a runtime dependency.
- What happens when only a JDK newer than the one Ghidra was verified on is installed? It is accepted (21 or newer); a JDK of exactly 21 is preferred when both exist.
- What happens when `JAVA_HOME` is set to a JDK too old for the engine? The check warns that it is not a JDK 21 or newer (or 17 or newer for jadx) and gives the path of a suitable one when it finds one.
- What happens when apktool is older than 2.7.0? The check warns and gives `brew upgrade apktool`.
- What happens when a jadx-headless-mcp jar of another version is under `~/.local/share/rea/jadx/`? It is passed as `REA_JADX_MCP_JAR`, and the check warns that REA 6.4.0 pins 0.7.1 and gives the pinned download.
- What happens when REA's own doctor takes longer than 90 seconds, prints no JSON, or does not start? The deep check adds one info line saying REA's own check could not run, with the reason. The other checks still show.
- What happens when REA's doctor reports more failures than fit? The first 12 are shown and the rest are counted in one line with the command to see them.
- What happens when `npx` is only in a version manager (nvm, Volta, asdf)? It is not found by the Homebrew fallback. The operator puts it on PATH or sets `rea_command` to an absolute command (see Assumptions).
- What happens when a readiness report is asked for again within ten minutes? The cached report is returned with its original time, unless `fresh` is asked for.
- What happens when an engine is installed while the daemon runs? The engine paths passed to REA are looked up again after 60 seconds. The readiness report is cached for ten minutes; **Check again** bypasses it.

## Requirements

### Detection

- **FR-001**: An investigation's target kind MUST default to `auto` in the UI, the API and the CLI (`trb evidence investigate --kind auto`). With `auto`, the kind MUST be decided from the target at create time.
- **FR-002**: Detection MUST follow these rules, in order, and stop at the first that matches:
  - an `http://` or `https://` URL, or a bare domain (no scheme, no path prefix, not ending in a file extension) → `web`;
  - a path that does not exist → `other` ("not found");
  - a folder ending in `.app`, or holding `Contents/Info.plist` → a macOS app: `electron` when `Contents/Resources/app.asar`, `Contents/Resources/app/` or `Contents/Frameworks/Electron Framework.framework` exists, else `binary` with the executable from `Info.plist` (`Contents/MacOS/<name>`);
  - any other folder with a `package.json` that depends on `electron` (dependencies, dev, peer or optional) → `electron`; any other folder → `other`;
  - a file ending in `.asar` → `electron`;
  - a file ending in `.apk`, `.aab` or `.xapk` → `android`;
  - a file whose first four bytes are a Mach-O, ELF or Windows PE magic → `binary`;
  - a zip (including `.jar`) or a WebAssembly module (`\0asm`) → `other`, for REA's `inspect_artifact`;
  - anything else → `other`, for REA's `inspect_artifact`.
- **FR-003**: Detection MUST read at most 8 KB of any one file, check a fixed list of markers, and never recurse into a folder. It MUST NOT write anything.
- **FR-004**: The stored investigation MUST keep the detected kind and `kind_reason`, a one-line reason for the operator. `kind_reason` MUST be null when the operator chose the kind.
- **FR-005**: An explicit kind MUST win over detection, even when detection would decide otherwise.
- **FR-006**: When a run starts on an investigation whose stored kind is `other` and that has a target, the kind MUST be detected again for that run, and the run MUST work the target as the kind it finds. The stored kind and `kind_reason` MUST stay as they were. Any other stored kind MUST be used as stored, except that a web address is always run as `web`.
- **FR-007**: The UI MUST show a detected kind as "Detected from the target: <reason>". The CLI MUST print the kind and reason after `investigate`.

### Readiness

- **FR-008**: The readiness checks MUST cover, in this order:
  - the launcher: `npx` (with `rea-agents@6.4.0`), or `rea_command` when set (FR-017 for the Homebrew fallback);
  - the native engine: Ghidra, Hopper or IDA. When none is found the fix is `brew install ghidra`. Hopper, when found, adds an info line that its free demo needs one manual first launch;
  - the JDK, for the engine that needs it: a JDK 21 or newer for Ghidra, preferring exactly 21; a JDK 17 or newer for jadx when Ghidra is not found. A `JAVA_HOME` set to a JDK too old for the engine is a warning of its own;
  - apktool, at 2.7.0 or newer;
  - the jadx-headless-mcp jar, at the pinned 0.7.1 (its fix line downloads that release from GitHub and checks its SHA-256);
  - adb, an info line (it is needed only for a connected device);
  - on Linux only, binwalk (REA 6.4.0 inspects firmware on Linux only; on macOS no firmware check is shown).
- **FR-009**: No readiness check MUST fail the run or raise an error. Each check is `ok`, `info` or `warn`. A `warn` MUST carry the command or setting that closes the gap. treeboss MUST NOT run a fix command for the operator.
- **FR-010**: The shallow check MUST only look at this machine (PATH, the Homebrew prefixes, `/Applications`, the environment, `~/.local/share/rea/jadx/`). It MUST NOT start REA or download anything. The Engines page runs only this check.
- **FR-011**: The deep check MUST also run REA's own `rea doctor --json`, started the way its MCP server is started, with a 90-second limit. Its failures MUST be shown as warnings prefixed "REA:", one line per distinct message, at most 12 lines. REA's client-registration and skill checks MUST be ignored, because treeboss does not own them. Only `trb doctor` and **Check again** run the deep check.
- **FR-012**: The readiness report MUST be cached in memory for ten minutes, per shallow and deep. `fresh` MUST bypass the cache.
- **FR-013**: `trb doctor` MUST show the `rea:*` lines and run the deep check. Settings > MCP > rea MUST show the warnings with copyable fix commands and **Check again**, which runs the deep check fresh. The Engines page MUST run the shallow check only.
- **FR-014**: `GET /api/rea/readiness` MUST return the report, with `deep=1` for the deep check and `fresh=1` to bypass the cache.

### Engine environment

- **FR-015**: When treeboss starts the `rea` MCP server, it MUST pass these variables, each only when the engine was found and the variable is not already set in the environment. The engines are looked up again every 60 seconds:
  - `GHIDRA_INSTALL_DIR`: the Ghidra install folder (the one that holds `support/analyzeHeadless`), from the Homebrew Cellar (formula), the Homebrew Caskroom, or `/Applications`;
  - `JAVA_HOME`: a JDK home for the engine: a JDK 21 (preferred) or newer for Ghidra, else a JDK 17 or newer for jadx. The candidates are `JAVA_HOME`, macOS's `java_home`, and the keg-only `openjdk` installs in the Homebrew prefixes, so REA does not use the macOS `java` stub;
  - `REA_APKTOOL_COMMAND`: the absolute path of apktool;
  - `REA_ADB_PATH`: the absolute path of adb;
  - `REA_JADX_MCP_JAR`: the jadx-headless-mcp jar: the pinned 0.7.1 under `~/.local/share/rea/jadx/0.7.1/` when present, else another version found there;
  - `REA_BINWALK_COMMAND`: the absolute path of binwalk, on Linux only.
- **FR-016**: A variable the operator has set MUST NOT be overwritten or removed. treeboss MUST NOT edit shell profiles to make an engine visible.

### Launcher

- **FR-017**: When `npx` is not on the daemon's PATH, treeboss MUST look for it in `/opt/homebrew/bin` and then `/usr/local/bin` and start REA with the file it finds. The directory that holds `npx` and `node` MUST be appended to the PATH of the REA process when it is not already on it. The launcher check MUST say where `npx` was found. A version manager's `npx` (nvm, Volta, asdf) is not searched for; it needs PATH or an absolute `rea_command`.

### Key Entities

- **Detected kind**: the kind and its one-line reason, worked out from the target. Stored on the investigation as `target_kind` and `kind_reason`.
- **Readiness check**: one line of the readiness report: an id, a level (`ok`, `info`, `warn`), its text and an optional fix command.
- **Readiness report**: the checks, when they were made, and whether the deep check ran.

## Success Criteria

- **SC-001**: For each target kind in the detection rules, a target of that kind created on auto is stored with that kind and a reason, with no operator choice.
- **SC-002**: On a machine where REA's engines are installed under the Homebrew defaults, a run can find Ghidra and its JDK with no shell profile edits.
- **SC-003**: Every missing engine on the readiness list shows its fix command in `trb doctor` and in Settings > MCP > rea.
- **SC-004**: No readiness check starts a session, starts REA or fails a run; REA's own failures show as "REA:" warnings, and a deep check that cannot run shows as one info line.

## Out of Scope

- Installing tools automatically. treeboss shows the command and never runs a package manager or a download for the operator.
- IDA setup. IDA needs IDA Pro and its upstream MCP (`REA_IDA_MCP_CONFIG`, `REA_ANALYSIS_PROVIDER=ida`); IDA Free is not supported by REA. treeboss reports IDA when found and does not configure it.
- Firmware work beyond the Linux binwalk check. treeboss does not unpack firmware or run REA's firmware tools itself.
- Hopper's first launch. Hopper's free demo asks for a mode choice the first time it opens; the readiness line tells the operator to open it once. treeboss does not drive the app.
- Detection beyond the rules above (no `.ipa`, no `.exe` by extension, no content sniffing past 8 KB).

## Assumptions

- The macOS setup in the README is what was installed on the machine this was built on: `brew install ghidra` (which pulls OpenJDK 21), `brew install apktool`, `brew install --cask android-platform-tools`, `brew install --cask hopper-disassembler`, and the jadx-headless-mcp 0.7.1 jar under `~/.local/share/rea/jadx/0.7.1/`.
- A detected kind is a suggestion the operator can override at create time; a run detects the kind again only for a stored `other`, and only for that run (FR-006).
- Readiness is a snapshot. A tool installed after the check shows up after **Check again** or when the ten-minute cache runs out. The engine paths passed to REA follow installs within 60 seconds.
- Version managers (nvm, Volta, asdf) are the operator's to put on PATH or to name with `rea_command`; treeboss does not read their shims.

## Open questions

None. The restart question that was open here is answered in spec 106 (Assumptions). A run in progress reads failed after a daemon restart.

## Unverified

Written from the brief and checked against the code as it has landed: the detection rules in FR-002 match `src/evidence/detect.ts`; the JDK floors, the jadx pin, the apktool minimum, the 60-second env cache, the 10-minute report cache and the npx fallback match `src/evidence/readiness.ts` and `src/evidence/rea.ts`. `bun test tests/rea-readiness.test.ts tests/evidence.test.ts` passed (75 tests) on the code as it stood when this revision was written. The readiness routes have route-level tests in `tests/rea-readiness.test.ts`, and the UI exists in `web/src/features/evidence/Investigations.tsx` and `McpRows.tsx`. FR-006 was checked against `resolveTarget` in `src/evidence/runs.ts`, which detects again for the run and writes nothing back, and against the "a run works a stored other as what its target is now" test.

Not checked: a GUI launch where `npx` is missing from PATH.
