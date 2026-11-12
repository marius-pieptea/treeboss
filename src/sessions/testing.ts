/**
 * How agents test, in every project. Left alone, an agent runs the whole suite and the end-to-end tests
 * after every small change and writes a test for each line it touches: on a real project that turns a
 * one-line fix into an hour of builds and browser runs. Said once per conversation (setting `test_policy`).
 */
export const TESTING_HINT = [
  `Testing (trb's rule for every project; an explicit request from the operator or in your brief overrides it):`,
  `- Run only the tests your change affects: the test files for the code you touched, with the runner's narrowest filter (\`bun test tests/x.test.ts\`, \`vitest run path\`, \`cargo test -p crate --test name\`, \`pytest path::test\`, \`go test ./pkg/...\`).`,
  `- Do not run the whole suite. Only when the change is cross-cutting (shared types, build config, a dependency upgrade) run it, once, at the end.`,
  `- Do not run end-to-end, browser, Playwright, device or load tests, or tests against live services, unless the operator or your brief asks for them by name. Project files that list such tests say how to run them when asked, not that every change needs them.`,
  `- Write tests sparingly: one that reproduces a bug you fix, and tests for new logic with real branches or edge cases. None for wiring, styling, copy, config, or behaviour an existing test already covers. Extend an existing test file before adding a new one.`,
  `- A test that also fails without your change is not yours: say so and move on. Do not rerun a passing test to double-check it.`,
].join("\n");
