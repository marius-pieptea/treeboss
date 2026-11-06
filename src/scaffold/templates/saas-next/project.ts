/**
 * saas-next: the environment template and the test setup. Every key the code reads must be listed in ENV_EXAMPLE
 * (tests/scaffold-golden.test.ts checks that).
 */

export const ENV_EXAMPLE = String.raw`# Copy to .env and fill in. Leave a value empty to turn that feature off; required keys are marked.
# Server code reads these through env() and optionalEnv() in src/lib/env.ts.

# Database (required). Any Postgres 14+; a local one is fine while developing.
DATABASE_URL=postgres://postgres:postgres@localhost:5432/{{name}}

# Auth (required). The secret is any long random string.
BETTER_AUTH_SECRET=change-me-to-a-long-random-string
BETTER_AUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Sign-in with GitHub and Google (optional; set both keys of a pair).
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Stripe (required for billing; use test keys while developing).
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_ID=

# PostHog analytics (optional). The key is public, so it is read by the browser too.
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com

# Sentry error reporting (optional). NEXT_PUBLIC_SENTRY_DSN is for the browser; SENTRY_DSN for the server.
SENTRY_DSN=
NEXT_PUBLIC_SENTRY_DSN=
# Only needed in CI, to upload source maps.
SENTRY_AUTH_TOKEN=

# Tests. Set PLAYWRIGHT_BASE_URL to run the browser tests against a deployed app instead of a local dev server.
PLAYWRIGHT_BASE_URL=
`;

export const VITEST_CONFIG_TS = String.raw`import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
`;

/** A unit test for the settings helper: the pattern for pure code under src/. */
export const ENV_TEST_TS = String.raw`import { afterEach, describe, expect, it } from "vitest";
import { env, optionalEnv } from "./env";

afterEach(() => {
  delete process.env.TEST_SETTING;
});

describe("env", () => {
  it("returns a set value", () => {
    process.env.TEST_SETTING = "value";
    expect(env("TEST_SETTING")).toBe("value");
  });

  it("names the key when it is missing", () => {
    expect(() => env("TEST_SETTING")).toThrow(/TEST_SETTING/);
  });

  it("treats an empty value as unset for optional keys", () => {
    process.env.TEST_SETTING = "";
    expect(optionalEnv("TEST_SETTING")).toBeUndefined();
  });
});
`;

export const PLAYWRIGHT_CONFIG_TS = String.raw`import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Starts the dev server unless a base URL was given (a deployed app, or one already running).
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : { command: "bun run dev", url: baseURL, reuseExistingServer: true },
});
`;

/** The smoke test: the public pages render and the health endpoint answers. */
export const SMOKE_SPEC_TS = String.raw`import { expect, test } from "@playwright/test";

test("the pricing page renders", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Plans for");
  await expect(page.getByRole("button", { name: "Subscribe" })).toBeVisible();
});

test("the sign-in page offers email sign-in", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("the health endpoint answers, with or without a database", async ({ request }) => {
  const res = await request.get("/api/health");
  expect([200, 503]).toContain(res.status());
});
`;
