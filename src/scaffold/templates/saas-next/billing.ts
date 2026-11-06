/**
 * saas-next: Stripe subscriptions. Checkout and the customer portal are form posts (no client JavaScript);
 * the webhook is the only thing that writes the subscription table.
 */

/** The Stripe client and the subscription helpers. Server code only. */
export const BILLING_TS = String.raw`import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { subscription } from "@/db/schema";
import { track } from "@/lib/analytics";
import { env } from "@/lib/env";

export const stripe = new Stripe(env("STRIPE_SECRET_KEY"));

/** Statuses that give access to paid features. */
const PAID = new Set(["active", "trialing"]);

/** The user's subscription row, or null if they have never subscribed. */
export async function subscriptionFor(userId: string) {
  const [row] = await db.select().from(subscription).where(eq(subscription.userId, userId)).limit(1);
  return row ?? null;
}

export function hasAccess(row: { status: string } | null): boolean {
  return row !== null && PAID.has(row.status);
}

/** Store what Stripe says about a subscription. The user id comes from the metadata set at checkout. */
export async function syncSubscription(sub: Stripe.Subscription): Promise<string | null> {
  const userId = sub.metadata.userId;
  if (!userId) return null; // not created by this app
  const item = sub.items.data[0];
  const values = {
    stripeSubscriptionId: sub.id,
    userId,
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    priceId: item?.price.id ?? "",
    status: sub.status,
    currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    updatedAt: new Date(),
  };
  await db.insert(subscription).values(values).onConflictDoUpdate({ target: subscription.stripeSubscriptionId, set: values });
  await track(userId, "subscription_updated", { status: sub.status });
  return userId;
}
`;

/** Start a Stripe Checkout for the subscription price. Signed-out visitors go to the sign-in page. */
export const CHECKOUT_ROUTE_TS = String.raw`import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { stripe, subscriptionFor } from "@/lib/billing";
import { currentUser } from "@/lib/auth";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await currentUser(await headers());
  if (!user) return NextResponse.redirect(new URL("/login", req.url), 303);

  // Reuse the Stripe customer when there is one, so a returning user is not created twice.
  const existing = await subscriptionFor(user.id);
  const origin = env("NEXT_PUBLIC_APP_URL");
  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: env("STRIPE_PRICE_ID"), quantity: 1 }],
    ...(existing ? { customer: existing.stripeCustomerId } : { customer_email: user.email }),
    client_reference_id: user.id,
    subscription_data: { metadata: { userId: user.id } },
    success_url: origin + "/pricing?checkout=success",
    cancel_url: origin + "/pricing",
  });
  if (!checkout.url) return NextResponse.json({ error: "Stripe did not return a checkout page." }, { status: 502 });
  return NextResponse.redirect(checkout.url, 303);
}
`;

/** Open the Stripe customer portal for the signed-in user's subscription. */
export const PORTAL_ROUTE_TS = String.raw`import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { stripe, subscriptionFor } from "@/lib/billing";
import { currentUser } from "@/lib/auth";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await currentUser(await headers());
  if (!user) return NextResponse.redirect(new URL("/login", req.url), 303);

  const row = await subscriptionFor(user.id);
  if (!row) return NextResponse.redirect(new URL("/pricing", req.url), 303);
  const portal = await stripe.billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    return_url: env("NEXT_PUBLIC_APP_URL") + "/pricing",
  });
  return NextResponse.redirect(portal.url, 303);
}
`;

/** Stripe's webhook. The signature is checked against the raw body before anything is trusted. */
export const WEBHOOK_ROUTE_TS = String.raw`import type Stripe from "stripe";
import { NextResponse } from "next/server";
import { stripe, syncSubscription } from "@/lib/billing";
import { env } from "@/lib/env";

export const runtime = "nodejs";

const HANDLED = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature." }, { status: 400 });

  // The raw text, not parsed JSON: the signature is computed over the exact bytes.
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, env("STRIPE_WEBHOOK_SECRET"));
  } catch {
    return NextResponse.json({ error: "Bad signature." }, { status: 400 });
  }

  if (HANDLED.has(event.type)) await syncSubscription(event.data.object as Stripe.Subscription);
  return NextResponse.json({ received: true });
}
`;

/** The pricing page: a plain form for each action, so it works before any client code loads. */
export const PRICING_PAGE_TSX = String.raw`export default function PricingPage() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <h1 className="text-3xl font-semibold">Plans for {{title}}</h1>
      <p>One subscription unlocks everything in the app. Manage it at any time from the billing portal.</p>
      <form action="/api/billing/checkout" method="post">
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">
          Subscribe
        </button>
      </form>
      <form action="/api/billing/portal" method="post">
        <button type="submit" className="rounded border px-4 py-2">
          Manage billing
        </button>
      </form>
    </main>
  );
}
`;
