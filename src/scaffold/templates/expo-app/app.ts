/**
 * expo-app: the Expo config, EAS profiles, API client, error reporting and store metadata. Same rules as the
 * saas-next templates: String.raw, no backticks, no dollar-brace, {{name}} and {{title}} filled in at write time.
 */

/** One app config for every build. EAS sets APP_VARIANT per profile; development and preview get their own bundle id. */
export const APP_CONFIG_TS = String.raw`import type { ConfigContext, ExpoConfig } from "expo/config";

// Set per profile in eas.json: development, preview or production.
const variant = process.env.APP_VARIANT ?? "development";
const slug = "{{name}}";
const suffix = variant === "production" ? "" : "." + variant;
// Android package names allow letters and digits only, so the id drops the dashes.
const id = "com.example." + slug.replace(/[^a-z0-9]/g, "") + suffix;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant === "production" ? "{{title}}" : "{{title}} (" + variant + ")",
  slug,
  scheme: slug,
  ios: { ...config.ios, bundleIdentifier: id },
  android: { ...config.android, package: id },
  extra: { ...config.extra, variant, eas: { projectId: process.env.EAS_PROJECT_ID } },
  plugins: [...(config.plugins ?? []), "@sentry/react-native/expo"],
});
`;

/** Build profiles. Replace the example.com addresses before the first preview build. */
export const EAS_JSON = `{
  "cli": { "version": ">= 16.0.0", "appVersionSource": "remote" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "channel": "development",
      "env": { "APP_VARIANT": "development", "EXPO_PUBLIC_API_URL": "http://localhost:3000" }
    },
    "preview": {
      "distribution": "internal",
      "channel": "preview",
      "env": { "APP_VARIANT": "preview", "EXPO_PUBLIC_API_URL": "https://staging.example.com" }
    },
    "production": {
      "channel": "production",
      "autoIncrement": true,
      "env": { "APP_VARIANT": "production", "EXPO_PUBLIC_API_URL": "https://api.example.com" }
    }
  },
  "submit": { "production": {} }
}
`;

/** The API client. Every request goes to EXPO_PUBLIC_API_URL, the saas-next app's origin. */
export const API_TS = String.raw`/**
 * The API client for the backend (the saas-next app). Paths are relative to the origin in EXPO_PUBLIC_API_URL.
 * Sign-in returns a session token (Better Auth's bearer plugin); pass it to setAuthToken and every request carries it.
 */
let token: string | null = null;

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function setAuthToken(next: string | null): void {
  token = next;
}

/** Read the base URL on each call. Expo inlines EXPO_PUBLIC_ values at build time, so this stays a literal read. */
function baseUrl(): string {
  const base = process.env.EXPO_PUBLIC_API_URL;
  if (!base) throw new Error("EXPO_PUBLIC_API_URL is not set. Copy .env.example to .env.");
  return base;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", "Bearer " + token);
  const res = await fetch(new URL(path, baseUrl()), { ...init, headers });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const message = body && typeof body.error === "string" ? body.error : res.statusText || "Request failed";
    throw new ApiError(res.status, message);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, data?: unknown) => apiFetch<T>(path, { method: "POST", body: data === undefined ? undefined : JSON.stringify(data) }),
};
`;

export const API_TEST_TS = String.raw`import { ApiError, api, apiFetch, setAuthToken } from "./api";

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  setAuthToken(null);
  delete process.env.EXPO_PUBLIC_API_URL;
});

/** A fetch stand-in that records each call and answers with the given status and body. */
function reply(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status < 400, status, statusText: "", json: async () => body } as Response;
  }) as typeof fetch;
  return calls;
}

describe("apiFetch", () => {
  it("sends the token and a JSON body to the configured origin", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://api.example.test";
    setAuthToken("abc");
    const calls = reply(200, { ok: true });
    await api.post("/api/things", { name: "x" });
    expect(calls[0]!.url).toBe("https://api.example.test/api/things");
    expect((calls[0]!.init.headers as Headers).get("authorization")).toBe("Bearer abc");
    expect(calls[0]!.init.body).toBe('{"name":"x"}');
  });

  it("throws an ApiError carrying the server's message", async () => {
    process.env.EXPO_PUBLIC_API_URL = "https://api.example.test";
    reply(401, { error: "Sign in first." });
    const err = await apiFetch("/api/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe("Sign in first.");
  });

  it("refuses to run without EXPO_PUBLIC_API_URL", async () => {
    reply(200, {});
    await expect(apiFetch("/api/me")).rejects.toThrow(/EXPO_PUBLIC_API_URL/);
  });
});
`;

/** Error reporting for the app. Call initSentry() from the root layout; a no-op without a DSN. */
export const SENTRY_TS = String.raw`import * as Sentry from "@sentry/react-native";

let started = false;

/** Start error reporting once, at the top of the root layout (app/_layout.tsx). Does nothing without EXPO_PUBLIC_SENTRY_DSN. */
export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (started || !dsn) return;
  started = true;
  Sentry.init({ dsn, tracesSampleRate: 0.2 });
}

export { Sentry };
`;

/** App Store and Play listing text. Limits: name and subtitle 30 characters, keywords 100 in total, description 4000. */
export const METADATA_JSON = `{
  "name": "{{title}}",
  "subtitle": "",
  "description": "",
  "keywords": [],
  "privacyUrl": "https://example.com/privacy",
  "screenshotsDir": "store/screenshots"
}
`;

export const ENV_EXAMPLE = String.raw`# Copy to .env. Only EXPO_PUBLIC_ keys reach the app bundle; the rest are read by the build.

# The saas-next backend. On a phone, localhost does not reach your computer: use a LAN or tunnel address.
EXPO_PUBLIC_API_URL=http://localhost:3000

# Sentry DSN for the app (optional).
EXPO_PUBLIC_SENTRY_DSN=

# Read by app.config.ts and the Sentry plugin at build time.
APP_VARIANT=development
EAS_PROJECT_ID=
SENTRY_ORG=
SENTRY_PROJECT=
SENTRY_AUTH_TOKEN=
`;
