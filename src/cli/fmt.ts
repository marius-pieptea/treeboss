const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const wrap = (open: number, close: number) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function statusColor(status: string): (s: string) => string {
  switch (status) {
    case "running":
      return c.cyan;
    case "idle":
      return c.green;
    case "failed":
      return c.red;
    case "closed":
      return c.gray;
    default:
      return (s) => s;
  }
}

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => stripAnsi(r[i] ?? "").length)));
  const line = (r: string[]) => r.map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat(Math.max(0, widths[i] - stripAnsi(cell).length)))).join("  ");
  const out = all.map(line);
  if (header) out[0] = c.dim(out[0]);
  return out.join("\n");
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "";
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function die(message: string, code = 1): never {
  console.error(c.red("error: ") + message);
  process.exit(code);
}

/** Print JSON and return the exit code, so a command can `return printJson(x)`. */
export function printJson(value: unknown): number {
  console.log(JSON.stringify(value, null, 2));
  return 0;
}

export function printLine(line: string): number {
  console.log(line);
  return 0;
}
