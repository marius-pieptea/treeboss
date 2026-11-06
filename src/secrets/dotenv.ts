/**
 * `.env` files, read and written as text. Pure: no file access here, so the store and the CLI share one format.
 *
 * Read: `KEY=value`, an optional `export ` prefix, `#` comments, single-quoted (literal) and double-quoted
 * (with \n \r \t \\ \" escapes) values, and a ` # comment` after an unquoted value. Lines that are not
 * assignments are counted as skipped, not guessed at. Multi-line values are not supported.
 *
 * Write: values that are plain are written bare; anything else is double-quoted and escaped, so `parse` gives back
 * exactly what `format` was given.
 */

export const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface DotenvEntry {
  key: string;
  value: string;
}

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const PLAIN = /^[A-Za-z0-9_\-./:@+,=]*$/;

function unquote(raw: string): string {
  const q = raw[0];
  if ((q === '"' || q === "'") && raw.length >= 2 && raw.endsWith(q)) {
    const inner = raw.slice(1, -1);
    if (q === "'") return inner;
    return inner.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c);
  }
  // Unquoted: the value ends at a " #" comment.
  return raw.replace(/\s+#.*$/, "").trim();
}

export function parseDotenv(text: string): { entries: DotenvEntry[]; skipped: number } {
  const byKey = new Map<string, string>();
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(LINE);
    if (!m) {
      skipped++;
      continue;
    }
    // A later assignment of the same key wins, as it does for most loaders.
    byKey.set(m[1]!, unquote(m[2]!.trim()));
  }
  return { entries: [...byKey].map(([key, value]) => ({ key, value })), skipped };
}

const escapeValue = (v: string): string => (PLAIN.test(v) ? v : `"${v.replace(/[\\"\n\r\t]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c]!)}"`);

export function formatDotenv(entries: DotenvEntry[], header?: string): string {
  const lines = entries.map((e) => `${e.key}=${escapeValue(e.value)}`);
  return (header ? `# ${header}\n` : "") + lines.join("\n") + (lines.length ? "\n" : "");
}
