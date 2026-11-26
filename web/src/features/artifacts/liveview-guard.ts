/**
 * URL allowlist for the embedded Artifacts live view (<webview> in Electron).
 *
 * Only HTTPS URLs on claude.ai, claude.com, or the SSO providers claude.ai redirects to are
 * permitted inside the embedded webview; anything else opens in the system browser.
 */
export function isAllowedLiveUrl(url: string): boolean {
  if (typeof url !== "string" || !url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  return (
    host === "claude.ai" ||
    host.endsWith(".claude.ai") ||
    host === "claude.com" ||
    host.endsWith(".claude.com") ||
    host === "accounts.google.com" ||
    host === "appleid.apple.com"
  );
}
