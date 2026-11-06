/**
 * saas-next: settings and sign-in (Better Auth). See ./database.ts for the conventions these share.
 */

/** Settings are read here. Server code only; browser code reads NEXT_PUBLIC_ keys as process.env.NAME. */
export const ENV_TS = String.raw`/** A required setting. Throws, naming the key, when it is missing or empty. */
export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("Missing " + name + ". Set it in .env (see .env.example).");
  return value;
}

/** An optional setting: undefined when it is unset or empty. */
export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}
`;

/** Better Auth: email and password, GitHub and Google when their keys are set, and the bearer plugin for the mobile app. */
export const AUTH_TS = String.raw`import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { env, optionalEnv } from "@/lib/env";

// BETTER_AUTH_SECRET and BETTER_AUTH_URL are read by Better Auth itself (see .env.example).
const github = optionalEnv("GITHUB_CLIENT_ID") ? { clientId: env("GITHUB_CLIENT_ID"), clientSecret: env("GITHUB_CLIENT_SECRET") } : undefined;
const google = optionalEnv("GOOGLE_CLIENT_ID") ? { clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET") } : undefined;

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  socialProviders: { ...(github ? { github } : {}), ...(google ? { google } : {}) },
  // The mobile app sends the session token as "Authorization: Bearer ..." (see the expo-app recipe).
  plugins: [bearer()],
});

/** The signed-in user for a request, or null. Pass the request headers: currentUser(await headers()). */
export async function currentUser(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  return session?.user ?? null;
}
`;

/** The React side of Better Auth, for client components. */
export const AUTH_CLIENT_TS = String.raw`import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
`;

/** Better Auth's catch-all route: sign-in, sign-up, sessions, OAuth callbacks. Do not add routes beside it. */
export const AUTH_ROUTE_TS = String.raw`import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
`;

/** Sign in or create an account with email and password, or with GitHub or Google. */
export const LOGIN_PAGE_TSX = String.raw`"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setError(null);
    const result =
      mode === "signin"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: email.split("@")[0] ?? email });
    setBusy(false);
    if (result.error) setError(result.error.message ?? "Could not sign in.");
    else window.location.assign("/pricing");
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">{mode === "signin" ? "Sign in" : "Create account"}</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input name="email" type="email" required placeholder="Email" className="rounded border px-3 py-2" />
        <input name="password" type="password" required minLength={8} placeholder="Password" className="rounded border px-3 py-2" />
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy} className="rounded bg-black px-3 py-2 text-white disabled:opacity-50">
          {mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
      <button type="button" onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/pricing" })} className="rounded border px-3 py-2">
        Continue with GitHub
      </button>
      <button type="button" onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/pricing" })} className="rounded border px-3 py-2">
        Continue with Google
      </button>
      <button type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="text-sm underline">
        {mode === "signin" ? "No account yet? Create one" : "Have an account? Sign in"}
      </button>
    </main>
  );
}
`;
