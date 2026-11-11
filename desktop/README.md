# Desktop app (Electron)

A thin Electron shell around the daemon. It ships three things: the compiled daemon (`trb`, built with
`bun build --compile`, no Bun install needed), the built web UI, and `main.cjs`. On launch it runs
`trb daemon start`, trades a sign-in ticket for a session cookie, and opens the UI in a window. On quit it
stops the daemon only if this app started it.

## Build

Run from `desktop/`. Needs Bun and Node.

```sh
bun install                 # once

bun run dist:mac            # dist/TreeBoss-<ver>-mac-arm64.dmg and -mac-x64.dmg
bun run dist:win            # dist/TreeBoss-Setup-<ver>.exe
bun run dist                # all platforms

bun run stage               # only compile the daemon + web UI for this machine (into stage/)
bun start                   # run the shell against stage/ without packaging
```

`stage.ts` builds `web/`, copies the skill packs from `src/skills/packs/` into `stage/packs/`, then compiles
`src/cli/main.ts` once per target (`darwin-arm64`, `darwin-x64`, `windows-x64`) into `stage/bin/<target>/`.
electron-builder (`electron-builder.yml`) copies the matching binary, `stage/web` and `stage/packs` into the app's
resources. The compiled daemon cannot read `src/`, so the packs travel beside it, as the web UI does. Bun
cross-compiles, so one Mac produces every target.

## Requirements and gotchas

- **Windows installer from a Mac needs Rosetta** (electron-builder's NSIS packager is an Intel binary):
  `softwareupdate --install-rosetta --agree-to-license`. First builds download Electron and NSIS (~1 min).
- **Unsigned.** macOS: right-click, Open on first launch. Windows: SmartScreen "unknown publisher", click
  More info, Run anyway. To sign later, drop `identity: null` / `signAndEditExecutable: false` in
  `electron-builder.yml` and add an Apple Developer ID (+ notarization) and a Windows code-signing cert.
- **Windows** works (tested by the author). The bundled CodeGraph binary is skipped there (falls back to
  `codegraph` on PATH).
- `playwright-core`'s optional `chromium-bidi` is marked `--external` in `stage.ts`; it is only needed if
  that code path runs.
- The Windows installer's integration page (folder and file "Open with TreeBoss", editor registration, PATH) lives in `build/installer.nsh`. It is wired through `nsis.include`. A build fails on NSIS warnings, so an unused variable breaks it.
- Icons: `build/icon.icns` (macOS) and `build/icon.ico` (Windows, 16–256 px, PNG entries) are picked up by electron-builder.
- Output (`stage/`, `dist/`) is gitignored.

## Updates

Packaged builds check GitHub Releases (`updater.cjs`, `electron-updater`) 15 s after launch and every 6 h. Windows
and the Linux AppImage download and install the update (restart prompt). macOS and the Linux tar.gz only show a
"new version available" prompt linking to the release page, because macOS self-update needs a signed app; set
`MAC_SIGNED` in `updater.cjs` once signed. Set `TRB_NO_UPDATE=1` to turn it off.

To release: bump `version` in `package.json` and `desktop/package.json`, tag `vX.Y.Z` and push the tag. The
`release.yml` workflow builds all three platforms and attaches installers plus `latest*.yml` to the GitHub release
(the feed files must be there, or installed apps find no update). The first build with the updater has to be installed
by hand; later ones arrive on their own.
