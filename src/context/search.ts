/**
 * Candidates for the composer's `@` popup: files, symbols and commits.
 *
 * Symbols come from CodeGraph when the workspace already has an index (this module never builds one),
 * else from a plain `git grep` for definitions. Matching is fuzzy and server-side so every client ranks the
 * same way.
 */
import path from "path";
import { codegraphBinary, findIndexRoot } from "../codegraph/detect";
import { listAllFiles } from "../fs/files";
import { log as gitLog } from "../git/ops";
import { runCmd, runGit } from "../git/run";

export type CandidateKind = "file" | "symbol" | "commit";

export interface Candidate {
  kind: CandidateKind;
  /** What goes in the chip: a path, `path:start-end` for a symbol, a commit sha. */
  value: string;
  label: string;
  detail?: string;
  score: number;
}

/** Subsequence match with bonuses for consecutive runs and word starts. Null when `q` is not a subsequence of `text`. */
export function fuzzy(q: string, text: string): number | null {
  if (!q) return 0;
  const a = q.toLowerCase();
  const t = text.toLowerCase();
  const base = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1;
  let ti = 0;
  let prev = -2;
  let score = 0;
  for (let qi = 0; qi < a.length; qi++) {
    const at = t.indexOf(a[qi], ti);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += 4;
    if (at === 0 || /[\/_\-.\s]/.test(text[at - 1]) || (text[at] !== t[at] && text[at - 1] === t[at - 1])) score += 5;
    if (at >= base) score += 2;
    score -= Math.min(at - ti, 12) * 0.15;
    prev = at;
    ti = at + 1;
  }
  const name = t.slice(base);
  if (name.startsWith(a)) score += 12;
  else if (name.includes(a)) score += 6;
  return score - text.length * 0.01;
}

export async function searchFiles(dir: string, q: string, limit = 12): Promise<Candidate[]> {
  const { files } = await listAllFiles(dir);
  const out: Candidate[] = [];
  for (const f of files) {
    const s = fuzzy(q, f);
    if (s !== null) out.push({ kind: "file", value: f, label: f.slice(f.lastIndexOf("/") + 1), detail: f, score: s });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

interface CgHit {
  node: { name: string; kind: string; filePath: string; startLine: number; endLine: number; signature?: string };
  score: number;
}

/** True when a CodeGraph index already exists for this directory and the binary is there. */
export function codegraphReady(dir: string): boolean {
  return Boolean(codegraphBinary() && findIndexRoot(dir));
}

export async function searchSymbols(dir: string, q: string, limit = 10): Promise<{ items: Candidate[]; engine: "codegraph" | "grep" }> {
  if (!q.trim()) return { items: [], engine: codegraphReady(dir) ? "codegraph" : "grep" };
  const bin = codegraphBinary();
  const root = codegraphReady(dir) ? findIndexRoot(dir) : null;
  if (bin && root) {
    const r = await runCmd(bin, ["query", q, "-p", root, "-l", String(limit), "-j"], { cwd: dir, timeoutMs: 8_000, maxBytes: 2_000_000 });
    if (r.code === 0) {
      try {
        const hits = JSON.parse(r.stdout.toString("utf-8")) as CgHit[];
        // Paths in the index are relative to the index root, which may sit above the workspace.
        const items = hits
          .filter((h) => h?.node?.filePath)
          .map((h) => {
            const file = path.relative(dir, path.join(root, h.node.filePath)).split(path.sep).join("/");
            return { kind: "symbol" as const, value: `${file}:${h.node.startLine}-${h.node.endLine}`, label: h.node.name, detail: `${h.node.kind} · ${file}:${h.node.startLine}`, score: h.score };
          })
          .filter((c) => !c.value.startsWith(".."));
        return { items, engine: "codegraph" };
      } catch {}
    }
  }
  return { items: await grepSymbols(dir, q, limit), engine: "grep" };
}

const DEF = "(function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl|object|record)";

/** Without an index: lines that look like a definition of something whose name contains the query. */
async function grepSymbols(dir: string, q: string, limit: number): Promise<Candidate[]> {
  const word = q.replace(/[^\w$]/g, "");
  if (!word) return [];
  const r = await runGit(["grep", "-n", "-I", "-i", "-E", `(^|[^A-Za-z0-9_$])${DEF}[[:space:]]+[A-Za-z0-9_$]*${[...word].join("[A-Za-z0-9_$]*")}[A-Za-z0-9_$]*`, "--", "."], { cwd: dir, timeoutMs: 8_000, maxBytes: 2_000_000 });
  if (r.code !== 0 && r.code !== 1) return [];
  const out: Candidate[] = [];
  for (const line of r.stdout.toString("utf-8").split("\n")) {
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const name = new RegExp(`(?:^|[^\\w$])${DEF}\\s+([A-Za-z0-9_$]+)`).exec(m[3])?.[2] ?? m[3].trim().slice(0, 40);
    const s = fuzzy(word, name);
    if (s === null) continue;
    const ln = Number(m[2]);
    out.push({ kind: "symbol", value: `${m[1]}:${ln}-${ln + 40}`, label: name, detail: `${m[1]}:${ln}`, score: s });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function searchCommits(dir: string, q: string, limit = 8): Promise<Candidate[]> {
  let entries;
  try {
    entries = await gitLog(dir, { limit: 300 });
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const e of entries) {
    let s: number | null;
    if (q && /^[0-9a-f]{4,40}$/i.test(q) && e.sha.startsWith(q.toLowerCase())) s = 100;
    else s = fuzzy(q, e.subject);
    if (s !== null) out.push({ kind: "commit", value: e.sha, label: e.subject, detail: `${e.short} · ${e.author}`, score: s - out.length * 0.001 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function searchAll(dir: string, q: string): Promise<{ items: Candidate[]; symbols: "codegraph" | "grep" }> {
  const [files, sym, commits] = await Promise.all([searchFiles(dir, q, 8), searchSymbols(dir, q, 6), searchCommits(dir, q, 5)]);
  return { items: [...files, ...sym.items, ...commits], symbols: sym.engine };
}
