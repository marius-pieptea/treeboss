import { describe, expect, test } from "bun:test";
import { isAllowedLiveUrl } from "../web/src/features/artifacts/liveview-guard";

describe("isAllowedLiveUrl", () => {
  test("allows claude.ai artifact and subdomain URLs over https", () => {
    expect(isAllowedLiveUrl("https://claude.ai/artifact/9c41e7d2-5a0b-4c1e-8f3a-2d6b1e0c77a4")).toBe(true);
    expect(isAllowedLiveUrl("https://claude.ai/code/artifact/9c41e7d2-5a0b-4c1e-8f3a-2d6b1e0c77a4")).toBe(true);
    expect(isAllowedLiveUrl("https://app.claude.ai/login")).toBe(true);
    expect(isAllowedLiveUrl("https://claude.com/login")).toBe(true);
    expect(isAllowedLiveUrl("https://auth.claude.com/oauth")).toBe(true);
  });

  test("allows SSO sign-in hosts over https", () => {
    expect(isAllowedLiveUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    expect(isAllowedLiveUrl("https://appleid.apple.com/auth/authorize")).toBe(true);
  });

  test("refuses non-https schemes", () => {
    expect(isAllowedLiveUrl("http://claude.ai/artifact/123")).toBe(false);
    expect(isAllowedLiveUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedLiveUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isAllowedLiveUrl("file:///etc/passwd")).toBe(false);
  });

  test("refuses lookalike and unlisted hosts", () => {
    expect(isAllowedLiveUrl("https://claude.ai.evil.com/artifact/123")).toBe(false);
    expect(isAllowedLiveUrl("https://evilclaude.ai/artifact/123")).toBe(false);
    expect(isAllowedLiveUrl("https://evilaccounts.google.com/")).toBe(false);
    expect(isAllowedLiveUrl("https://example.com/?next=https://claude.ai/artifact/123")).toBe(false);
  });

  test("refuses invalid strings", () => {
    expect(isAllowedLiveUrl("not a url")).toBe(false);
    expect(isAllowedLiveUrl("")).toBe(false);
  });
});
