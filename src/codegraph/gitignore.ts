/** Add `.codegraph/` to a project's .gitignore: appended only if not already ignored, nothing else touched. */
import fs from "fs";
import path from "path";

const ENTRY = ".codegraph/";
const COVERS = new Set([".codegraph", ".codegraph/", "/.codegraph", "/.codegraph/", ".codegraph/*", "/.codegraph/*", "**/.codegraph", "**/.codegraph/"]);

function insideGitCheckout(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, ".git"))) return true;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

export type IgnoreResult = { changed: boolean; reason: "added" | "created" | "already-ignored" | "not-a-git-checkout" };

export function ensureCodegraphIgnored(dir: string): IgnoreResult {
  if (!insideGitCheckout(dir)) return { changed: false, reason: "not-a-git-checkout" };
  const file = path.join(dir, ".gitignore");
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {}
  if (text === null) {
    fs.writeFileSync(file, `${ENTRY}\n`);
    return { changed: true, reason: "created" };
  }
  const covered = text.split(/\r?\n/).some((l) => COVERS.has(l.trim()));
  if (covered) return { changed: false, reason: "already-ignored" };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lead = text.length === 0 || text.endsWith("\n") ? "" : eol;
  fs.appendFileSync(file, `${lead}${ENTRY}${eol}`);
  return { changed: true, reason: "added" };
}
