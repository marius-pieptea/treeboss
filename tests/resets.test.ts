import { describe, expect, test } from "bun:test";
import { MAX_PARK_MS, limitResetAt, resetFromRateLimitEvent } from "../src/engines/resets";

const at = (iso: string) => Date.parse(iso);

describe("limitResetAt: the reset time a limit failure names", () => {
  test("claude's pipe form: an epoch in seconds after the message", () => {
    const now = at("2026-10-18T10:00:00Z");
    expect(limitResetAt("Claude AI usage limit reached|1792400000", now)).toBe(1792400000 * 1000);
  });

  test("an epoch in milliseconds is read as milliseconds", () => {
    const now = at("2026-10-18T10:00:00Z");
    expect(limitResetAt("Claude AI usage limit reached|1792400000000", now)).toBe(1792400000000);
  });

  test("an ISO timestamp after 'resets'", () => {
    const now = at("2026-10-18T12:00:00Z");
    expect(limitResetAt("rate limit exceeded, resets at 2026-10-18T15:00:00Z", now)).toBe(at("2026-10-18T15:00:00Z"));
  });

  test("a clock time with a zone: 'resets 3pm (Europe/Bucharest)' is 12:00Z in October", () => {
    const now = at("2026-10-18T10:00:00Z");
    expect(limitResetAt("5-hour limit reached ∙ resets 3pm (Europe/Bucharest)", now)).toBe(at("2026-10-18T12:00:00Z"));
  });

  test("a clock time already passed today means tomorrow", () => {
    const now = at("2026-10-18T13:00:00Z"); // 16:00 in Bucharest
    expect(limitResetAt("You've hit your limit · resets 3pm (Europe/Bucharest)", now)).toBe(at("2026-10-19T12:00:00Z"));
  });

  test("a 24-hour clock with a UTC suffix", () => {
    const now = at("2026-10-18T10:00:00Z");
    expect(limitResetAt("usage limit reached, resets 15:30 UTC", now)).toBe(at("2026-10-18T15:30:00Z"));
  });

  test("a month and day with a time: 'resets Oct 20, 3pm (Europe/Bucharest)'", () => {
    const now = at("2026-10-18T10:00:00Z");
    expect(limitResetAt("usage limit reached, resets Oct 20, 3pm (Europe/Bucharest)", now)).toBe(at("2026-10-20T12:00:00Z"));
  });

  test("a bare number after 'resets' is not a clock time", () => {
    expect(limitResetAt("usage limit reached, resets 2 hours from now", at("2026-10-18T10:00:00Z"))).toBeNull();
  });

  test("an unknown zone name is unparseable (the caller falls back to failed)", () => {
    expect(limitResetAt("usage limit reached, resets 3pm (Mars/Olympus)", at("2026-10-18T10:00:00Z"))).toBeNull();
  });

  test("a reset that already passed is not trusted", () => {
    const now = at("2026-10-18T10:00:00Z");
    expect(limitResetAt("Claude AI usage limit reached|1700000000", now)).toBeNull();
  });

  test("a reset further out than the longest window is not trusted", () => {
    const now = at("2026-10-18T10:00:00Z");
    const far = Math.floor((now + MAX_PARK_MS + 3600_000) / 1000);
    expect(limitResetAt(`usage limit reached|${far}`, now)).toBeNull();
  });

  test("a limit with no reset time is unparseable", () => {
    expect(limitResetAt("Provider rate limit hit. Please try again later.", at("2026-10-18T10:00:00Z"))).toBeNull();
    expect(limitResetAt("429 Too Many Requests", at("2026-10-18T10:00:00Z"))).toBeNull();
  });

  test("text that is not a limit never parks, even with a time in it", () => {
    expect(limitResetAt("the build resets 3pm (Europe/Bucharest) and fails", at("2026-10-18T10:00:00Z"))).toBeNull();
    expect(limitResetAt("", at("2026-10-18T10:00:00Z"))).toBeNull();
  });

  test("spend and quota limits never park, whatever they say about a reset", () => {
    const now = at("2026-10-18T10:00:00Z");
    expect(limitResetAt("monthly spend limit reached, resets Nov 1", now)).toBeNull();
    expect(limitResetAt("insufficient credits; limit reached, resets 3pm (Europe/Bucharest)", now)).toBeNull();
  });
});

describe("resetFromRateLimitEvent: claude's own rejected event", () => {
  const now = at("2026-10-18T10:00:00Z");
  const resetsAt = Math.floor(at("2026-10-18T13:00:00Z") / 1000);

  test("a rejected event with resetsAt (epoch seconds) gives the reset", () => {
    expect(resetFromRateLimitEvent({ status: "rejected", resetsAt, rateLimitType: "five_hour" }, now)).toBe(at("2026-10-18T13:00:00Z"));
  });

  test("an allowed or warning event never parks", () => {
    expect(resetFromRateLimitEvent({ status: "allowed_warning", resetsAt }, now)).toBeNull();
    expect(resetFromRateLimitEvent({ status: "allowed", resetsAt }, now)).toBeNull();
  });

  test("a rejected event without a usable resetsAt gives nothing", () => {
    expect(resetFromRateLimitEvent({ status: "rejected" }, now)).toBeNull();
    expect(resetFromRateLimitEvent(null, now)).toBeNull();
    expect(resetFromRateLimitEvent("rejected", now)).toBeNull();
  });
});
