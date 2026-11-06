/** Split a multi-file unified diff into per-file pieces, with counts, for the Changes file list. Pure. */
export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "renamed" | "modified" | "binary";
  additions: number;
  deletions: number;
  /** The file's own diff text, header included, ready to hand to a diff renderer. */
  text: string;
}

export function splitDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];
  const blocks = diff.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  return blocks.map((text) => {
    const head = text.split("\n", 1)[0];
    // `diff --git a/<old> b/<new>`: paths may contain spaces, so anchor on the " b/" that follows an "a/…" prefix.
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(head);
    let path = m?.[2] ?? head.slice(11);
    const oldPath = m?.[1];
    let status: DiffFile["status"] = "modified";
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of text.split("\n")) {
      if (line.startsWith("@@")) inHunk = true;
      else if (!inHunk) {
        if (line.startsWith("new file mode")) status = "added";
        else if (line.startsWith("deleted file mode")) status = "deleted";
        else if (line.startsWith("rename to ")) (status = "renamed", (path = line.slice(10)));
        else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) status = "binary";
      } else if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
    return { path, ...(status === "renamed" && oldPath && oldPath !== path ? { oldPath } : {}), status, additions, deletions, text };
  });
}

export function summarize(files: DiffFile[]): { files: number; additions: number; deletions: number } {
  return files.reduce((s, f) => ({ files: s.files + 1, additions: s.additions + f.additions, deletions: s.deletions + f.deletions }), { files: 0, additions: 0, deletions: 0 });
}
