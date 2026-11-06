/**
 * Which specs and roadmap items mention a documentation page. A read-only lookup by path: the files are
 * plain markdown, so a mention is either the page's path or a markdown link ending in its file name. No
 * knowledge of how specs or the roadmap are structured is needed, and nothing is stored.
 */
import fs from "fs";
import path from "path";

export interface Backlink {
  path: string;
  kind: "spec" | "roadmap";
  line: number;
  text: string;
}

const MAX_FILES = 300;
const MAX_BYTES = 200 * 1024;
const PER_FILE = 3;
const MD = /\.(md|mdx|markdown)$/i;

/** Where specs and a roadmap may live, in Spec Kit's layout and the usual roadmap spots. */
const SOURCES: Array<{ rel: string; kind: Backlink["kind"] }> = [
  { rel: "specs", kind: "spec" },
  { rel: ".specify", kind: "spec" },
  { rel: "roadmap", kind: "roadmap" },
  { rel: "ROADMAP.md", kind: "roadmap" },
  { rel: "roadmap.md", kind: "roadmap" },
];

function mdFiles(rootDir: string, rel: string, out: string[]): void {
  const abs = path.join(rootDir, rel);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (MD.test(rel) && out.length < MAX_FILES) out.push(rel);
    return;
  }
  if (!st.isDirectory()) return;
  let names: string[];
  try {
    names = fs.readdirSync(abs).sort();
  } catch {
    return;
  }
  for (const n of names) {
    if (out.length >= MAX_FILES) return;
    if (n === "node_modules" || n === ".git") continue;
    mdFiles(rootDir, `${rel}/${n}`, out);
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function backlinksFor(rootDir: string, docsDir: string, docPath: string): Backlink[] {
  const inner = docPath.startsWith(`${docsDir}/`) ? docPath.slice(docsDir.length + 1) : docPath;
  const base = path.basename(docPath);
  // The page's full path, its path inside the docs folder (as the roadmap or a spec may link it), or a link to its file name.
  const re = new RegExp(`(?:^|[\\s(\`"'/])${esc(docPath)}(?![\\w-])|(?:^|[\\s(\`"'/])${esc(inner)}(?![\\w-])|\\]\\([^)]*${esc(base)}(?:#[^)]*)?\\)`);
  const out: Backlink[] = [];
  // ROADMAP.md and roadmap.md are one file on a case-insensitive disk: read each real file once.
  const seen = new Set<string>();
  for (const src of SOURCES) {
    const files: string[] = [];
    mdFiles(rootDir, src.rel, files);
    for (const f of files) {
      if (f === docPath) continue;
      let text: string;
      try {
        const real = fs.realpathSync(path.join(rootDir, f));
        if (seen.has(real)) continue;
        seen.add(real);
        const st = fs.statSync(path.join(rootDir, f));
        if (st.size > MAX_BYTES) continue;
        text = fs.readFileSync(path.join(rootDir, f), "utf-8");
      } catch {
        continue;
      }
      let n = 0;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && n < PER_FILE; i++) {
        if (re.test(lines[i])) {
          out.push({ path: f, kind: src.kind, line: i + 1, text: lines[i].trim().slice(0, 160) });
          n++;
        }
      }
    }
  }
  return out.slice(0, 40);
}
