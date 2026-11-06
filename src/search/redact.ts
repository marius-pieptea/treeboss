/**
 * Best-effort removal of obvious secrets from text that is about to leave the machine (an HTML export).
 * It catches well-known token shapes, `NAME=value` assignments whose name says secret, bearer and basic
 * credentials, credentials inside URLs and PEM private keys. It cannot know a secret that looks like prose,
 * so the export dialog says it is best effort and the operator should still look before sharing.
 */
export const REDACTED = "[redacted]";

const KEYWORD = "(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|credential)";

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Authorization headers and bearer tokens.
  [/\b(Authorization\s*[:=]\s*)(?:Bearer|Basic|Token)?\s*[^\s"'`]{6,}/gi, (_m, p) => `${p}${REDACTED}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, (_m, p) => `${p}${REDACTED}`],
  // user:password@ inside a URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, (_m, a, b) => `${a}${REDACTED}${b}`],
  // NAME=value, NAME: value, "name": "value" where the name says secret.
  [new RegExp(`(\\b[A-Za-z0-9_.-]*${KEYWORD}[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*["']?)(?!\\d+(?:[\\s"'\`,;)}\\]]|$))(?!\\[redacted\\])([^\\s"'\`,;)}\\]]{6,})`, "gi"), (_m, p) => `${p}${REDACTED}`],
];

function blankValues(pairs: string): string {
  return pairs
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq < 0 ? pair : `${pair.slice(0, eq)}=${REDACTED}`;
    })
    .join("&");
}

/**
 * The address with the value of every query param replaced, names kept. A value is a secret whatever its name
 * (`?code=` is a PIN as often as a page), so this keeps no name list. The hash is treated the same when it
 * carries a query (`#/route?a=b`) or is itself `name=value` pairs (`#access_token=...`).
 */
export function stripQueryValues(url: string): string {
  const h = url.indexOf("#");
  const base = h < 0 ? url : url.slice(0, h);
  const q = base.indexOf("?");
  const head = q < 0 ? base : `${base.slice(0, q + 1)}${blankValues(base.slice(q + 1))}`;
  if (h < 0) return head;
  const hash = url.slice(h + 1);
  const hq = hash.indexOf("?");
  if (hq >= 0) return `${head}#${hash.slice(0, hq + 1)}${blankValues(hash.slice(hq + 1))}`;
  return `${head}#${hash.includes("=") ? blankValues(hash) : hash}`;
}

export function redact(text: string): string {
  let out = text;
  for (const [re, to] of PATTERNS) out = out.replace(re, to as any);
  return out;
}
