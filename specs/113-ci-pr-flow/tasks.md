# Tasks: CI workflow and pull requests from sessions

- [x] T001 Write the spec and plan in specs/113-ci-pr-flow/
- [x] T002 Detect the project and render the workflow in src/ci/workflow.ts
- [x] T003 Write the workflow without overwriting in src/ci/workflow.ts (writeWorkflow)
- [x] T004 gh wrappers with an injectable runner in src/ci/pr.ts (prCreate, prView, prChecks, prMerge, prList)
- [x] T005 session_prs table, refreshPr and waitForChecks in src/ci/pr.ts
- [x] T006 sessionToPr: push the branch and open the PR from the session in src/ci/pr.ts
- [x] T007 HTTP routes in src/daemon/routes/ci.ts
- [x] T008 CLI `trb pr` in src/cli/commands/pr.ts and `trb ci init` in src/cli/commands/ci.ts
- [x] T009 PrPanel and OpenPrButton in web/src/features/ci/
- [x] T010 Tests with fixture folders, a scripted gh and a local remote in tests/ci.test.ts
- [x] T011 Register the routes, the CLI commands and the web components in the shell
- [x] T012 Autopilot calls waitForChecks after a PR opens, opt-in with `open_pr` (src/autopilot/runner.ts `watchChecks`, `trb autopilot start --open-pr`)
