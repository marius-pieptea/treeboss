/**
 * saas-next: health, errors and analytics. Each piece does nothing when its key is unset, so a fresh clone runs
 * without any accounts.
 */

/** Liveness with a database check. Unauthenticated on purpose: uptime monitors and the mobile app call it. */
export const HEALTH_ROUTE_TS = String.raw`import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql.raw("select 1"));
    return NextResponse.json({ status: "ok", database: "up" });
  } catch {
    return NextResponse.json({ status: "degraded", database: "down" }, { status: 503 });
  }
}
`;

/** Server-side Sentry, started once by Next.js. Errors in route handlers are reported through onRequestError. */
export const INSTRUMENTATION_TS = String.raw`import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
  }
}

export const onRequestError = Sentry.captureRequestError;
`;

/** Browser-side Sentry and PostHog, started before the app renders. */
export const INSTRUMENTATION_CLIENT_TS = String.raw`import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";

Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, tracesSampleRate: 0.1 });

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
if (posthogKey) {
  posthog.init(posthogKey, { api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com" });
}
`;

/** Server-side PostHog events. Each call flushes, which suits serverless; a no-op without a key. */
export const ANALYTICS_TS = String.raw`import { PostHog } from "posthog-node";
import { optionalEnv } from "@/lib/env";

let client: PostHog | undefined;

/** Send one server-side event for a user. Does nothing when NEXT_PUBLIC_POSTHOG_KEY is unset. */
export async function track(distinctId: string, event: string, properties: Record<string, unknown> = {}): Promise<void> {
  const key = optionalEnv("NEXT_PUBLIC_POSTHOG_KEY");
  if (!key) return;
  client ??= new PostHog(key, { host: optionalEnv("NEXT_PUBLIC_POSTHOG_HOST") ?? "https://us.i.posthog.com" });
  client.capture({ distinctId, event, properties });
  await client.flush();
}
`;
