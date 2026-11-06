/** Resolve a link or image path found in a document against the document's own directory (pure). */
export function resolveRelative(fileDir: string, ref: string): string | null {
  if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null; // absolute URLs, data:, anchors are left alone
  const clean = ref.split(/[?#]/)[0];
  const parts = (clean.startsWith("/") ? clean.slice(1) : `${fileDir ? `${fileDir}/` : ""}${clean}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (!out.length) return null; // would climb out of the workspace
      out.pop();
    } else out.push(decodeURIComponent(p));
  }
  return out.join("/");
}
