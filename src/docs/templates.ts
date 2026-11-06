/** Page templates the Docs module writes on an explicit action: a blank page, an ADR, and the folder's index. */

export const DEFAULT_DOCS_DIR = "docs";
export const DECISIONS_DIR = "decisions";

export const slugify = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export const titleFromSlug = (slug: string): string => {
  const t = slug.replace(/\.(md|mdx|markdown)$/i, "").replace(/^\d{4}-/, "").replace(/[-_]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "Untitled";
};

export type PageKind = "page" | "adr" | "index";

export function pageTemplate(title: string, kind: PageKind = "page", opts: { number?: string; date?: string } = {}): string {
  if (kind === "adr") {
    const n = opts.number ?? "0001";
    return [
      "---",
      `title: ${JSON.stringify(`${n}. ${title}`)}`,
      "status: draft",
      "---",
      "",
      `# ${n}. ${title}`,
      "",
      `Date: ${opts.date ?? new Date().toISOString().slice(0, 10)}`,
      "",
      "## Status",
      "",
      "Proposed",
      "",
      "## Context",
      "",
      "What forces are at play: the problem, the constraints, what was tried or considered.",
      "",
      "## Decision",
      "",
      "What was decided, in one or two sentences, in the active voice (\"We will …\").",
      "",
      "## Consequences",
      "",
      "What becomes easier, what becomes harder, what has to change because of this.",
      "",
    ].join("\n");
  }
  if (kind === "index") {
    return [
      "---",
      `title: ${JSON.stringify(title)}`,
      "---",
      "",
      `# ${title}`,
      "",
      "What this project is, in two sentences.",
      "",
      "## Where things are",
      "",
      "- Architecture: how the parts fit together.",
      "- Conventions: how code is written here.",
      "- Decisions: why things are the way they are (`decisions/`).",
      "",
    ].join("\n");
  }
  return ["---", `title: ${JSON.stringify(title)}`, "status: draft", "---", "", `# ${title}`, "", "Write here.", ""].join("\n");
}
