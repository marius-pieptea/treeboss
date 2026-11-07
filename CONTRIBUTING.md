# Contributing

Issues and pull requests are welcome. Here is how it works.

## Before you start

- **Small fixes** (a bug, a typo, a test): open a pull request directly.
- **Larger features:** open an issue first so we can agree on the scope. Accepted features start as a folder in `specs/` (spec, plan, tasks).
- **Security problems:** do not open an issue. See [SECURITY.md](SECURITY.md).

## The workflow

1. Fork the repository and create a branch from `main`.
2. Run `bun install`.
3. Make the change. Keep it small and focused, and match the surrounding style.
4. Run `bun run typecheck`, and the test files your change affects: `bun test tests/<name>.test.ts`. No model is called in tests. CI runs the whole suite on Linux for every pull request.
5. Open a pull request and fill in the template.
6. The first time you contribute, the CLA bot asks you to sign the [Contributor License Agreement](CLA.md) by posting a comment on the pull request. It takes one comment.
7. The maintainer reviews the pull request. Once CI is green and the review is approved, it is squash-merged.

## Guidelines

- UI work: read `DESIGN.md` and use only the tokens in `design/tokens.css`.
- Add or update tests for behavior you change.
- If an AI tool wrote part of your change, you are still its author: read all of it, run it, and be ready to explain it.

## Why a CLA

TreeBoss is under the [PolyForm Shield License](LICENSE), and the maintainer also offers commercial licenses (see [LICENSING.md](LICENSING.md)). The CLA lets the maintainer include your contribution under both. You keep the copyright to your work.
