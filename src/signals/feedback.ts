/**
 * Feedback intake: what a visitor of the product's site sends through the embeddable widget. The HTTP side
 * (token in the path, CORS, status codes) is in daemon/routes/signals.ts; this file holds the rules.
 *
 * The same message from the same page is one signal whose count grows, not a new row per click.
 */
import crypto from "crypto";
import { UserError } from "../util";
import { findSignal, upsertSignal } from "./store";
import type { Signal } from "./types";

export const FEEDBACK_MAX_MESSAGE = 4_000;
export const FEEDBACK_MAX_BYTES = 16_000;
const MAX_PAGE = 500;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** At most this many submissions per window from one peer. Tokens are 192-bit, so the limit is about abuse, not guessing. */
export const FEEDBACK_RATE = { windowMs: 60_000, max: 30 };
const hits = new Map<string, number[]>();

/** Take one submission slot for `key` (the peer address). False when the window is full. */
export function takeFeedbackSlot(key: string, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < FEEDBACK_RATE.windowMs);
  if (recent.length >= FEEDBACK_RATE.max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

/** Tests only: forget the submission counts. */
export function resetFeedbackLimits(): void {
  hits.clear();
}

export interface FeedbackInput {
  message: string;
  email: string | null;
  page: string | null;
  rating: number | null;
}

/** Check a submitted body. Throws UserError (400) on anything out of bounds, so a bad field never reaches the store. */
export function parseFeedback(raw: unknown): FeedbackInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UserError("Send a JSON object with a message.");
  const b = raw as Record<string, unknown>;
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message) throw new UserError("A message is required.");
  if (message.length > FEEDBACK_MAX_MESSAGE) throw new UserError(`The message is longer than ${FEEDBACK_MAX_MESSAGE} characters.`);
  const email = typeof b.email === "string" && b.email.trim() ? b.email.trim() : null;
  if (email && (email.length > MAX_EMAIL || !EMAIL.test(email))) throw new UserError("The email address does not look valid.");
  const page = typeof b.page === "string" && b.page.trim() ? b.page.trim().slice(0, MAX_PAGE) : null;
  let rating: number | null = null;
  if (b.rating !== undefined && b.rating !== null && b.rating !== "") {
    const n = Number(b.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new UserError("The rating must be a whole number from 1 to 5.");
    rating = n;
  }
  return { message, email, page, rating };
}

/** Store one submission. Identical message and page from before bump the count of that signal. */
export function acceptFeedback(workspaceId: string, input: FeedbackInput, now = new Date().toISOString()): Signal {
  const key = crypto.createHash("sha256").update(JSON.stringify([input.message.toLowerCase(), input.page ?? ""])).digest("hex").slice(0, 32);
  const prior = findSignal(workspaceId, "feedback", key);
  const severity = input.rating === null ? "medium" : input.rating <= 2 ? "high" : input.rating === 3 ? "medium" : "low";
  const firstLine = input.message.split("\n")[0]!.trim();
  return upsertSignal(workspaceId, {
    source: "feedback",
    kind: "feedback",
    externalId: key,
    title: firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine,
    body: [input.message, input.email ? `From: ${input.email}` : "", input.rating !== null ? `Rating: ${input.rating}/5` : ""].filter(Boolean).join("\n"),
    severity,
    count: (prior?.count ?? 0) + 1,
    url: input.page,
    meta: { page: input.page, rating: input.rating, email: input.email },
    lastSeen: now,
  });
}

/**
 * A small script-and-markup widget for the product's own pages. It runs on someone else's site, so it carries
 * its own plain styling and does not use the app's design tokens. Text is set with textContent, never innerHTML.
 */
export function widgetSnippet(endpoint: string, o: { label?: string } = {}): string {
  const label = (o.label ?? "Feedback").slice(0, 40);
  const js = JSON.stringify({ endpoint, label }).replace(/</g, "\\u003c");
  return `<!-- TreeBoss feedback widget -->
<script>
(function () {
  var cfg = ${js};
  var btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = cfg.label;
  btn.setAttribute("style", "position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:6px 12px;border:1px solid #d4d4d8;border-radius:6px;background:#fff;color:#1a1a1c;font:13px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.12)");
  var box = document.createElement("form");
  box.setAttribute("style", "display:none;position:fixed;right:16px;bottom:56px;z-index:2147483000;width:300px;padding:12px;border:1px solid #d4d4d8;border-radius:8px;background:#fff;color:#1a1a1c;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.14)");
  var area = document.createElement("textarea");
  area.required = true;
  area.maxLength = ${FEEDBACK_MAX_MESSAGE};
  area.placeholder = "What is on your mind?";
  area.setAttribute("style", "width:100%;box-sizing:border-box;min-height:80px;padding:6px;border:1px solid #d4d4d8;border-radius:6px;font:inherit");
  var mail = document.createElement("input");
  mail.type = "email";
  mail.placeholder = "Email (optional)";
  mail.setAttribute("style", "width:100%;box-sizing:border-box;margin-top:8px;padding:6px;border:1px solid #d4d4d8;border-radius:6px;font:inherit");
  var rate = document.createElement("select");
  rate.setAttribute("style", "margin-top:8px;padding:4px;font:inherit");
  var none = document.createElement("option");
  none.value = "";
  none.textContent = "Rate it (optional)";
  rate.appendChild(none);
  for (var i = 1; i <= 5; i++) {
    var o = document.createElement("option");
    o.value = String(i);
    o.textContent = i + " / 5";
    rate.appendChild(o);
  }
  var send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Send";
  send.setAttribute("style", "margin-top:8px;float:right;padding:6px 12px;border:0;border-radius:6px;background:#1a1a1c;color:#fff;font:inherit;cursor:pointer");
  var note = document.createElement("div");
  note.setAttribute("style", "margin-top:8px;min-height:16px;color:#55555c");
  box.appendChild(area);
  box.appendChild(mail);
  box.appendChild(rate);
  box.appendChild(send);
  box.appendChild(note);
  btn.addEventListener("click", function () {
    box.style.display = box.style.display === "none" ? "block" : "none";
  });
  box.addEventListener("submit", function (ev) {
    ev.preventDefault();
    note.textContent = "Sending...";
    var body = { message: area.value, page: location.href };
    if (mail.value) body.email = mail.value;
    if (rate.value) body.rating = Number(rate.value);
    fetch(cfg.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        note.textContent = "Thank you. It was sent.";
        area.value = "";
      })
      .catch(function () {
        note.textContent = "It did not send. Try again later.";
      });
  });
  document.body.appendChild(btn);
  document.body.appendChild(box);
})();
</script>
`;
}
