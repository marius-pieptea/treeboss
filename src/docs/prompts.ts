/**
 * What the app asks an agent to do when it writes or refreshes documentation. The contract is the same for
 * every kind of page and is spelled out in full, because the daemon checks the result against it: front
 * matter that says what the page covers and when it was written, human-written sections left alone, files
 * written only inside the docs folder, and a last line naming the pages touched.
 */
import type { Freshness } from "./staleness";

export type GenKind = "overview" | "architecture" | "module" | "conventions" | "runbook" | "adr" | "refresh";

export const GEN_KINDS: GenKind[] = ["overview", "architecture", "module", "conventions", "runbook", "adr", "refresh"];

export interface KindSpec {
  label: string;
  /** Relative to the docs folder. `module` and `adr` are named by the caller. */
  defaultFile: string | null;
  describes: string;
}

export const KIND_SPECS: Record<GenKind, KindSpec> = {
  overview: { label: "Overview", defaultFile: "index.md", describes: "What the project is, who it is for, how to run it, and where everything else is documented. Short: a reader should know in a minute whether this is the right repository." },
  architecture: { label: "Architecture", defaultFile: "architecture.md", describes: "How the system is put together: the main components, what each owns, how data and control flow between them, and the constraints that shaped it. Name real directories and files." },
  module: { label: "Module reference", defaultFile: null, describes: "One module or area of the code: its purpose, its public surface (functions, routes, commands, types), how it is used, and what it must not be used for." },
  conventions: { label: "Conventions", defaultFile: "conventions.md", describes: "How code is written and changed here: naming, structure, error handling, testing, commit and review habits. Only what the code and its tooling actually show, never invented norms." },
  runbook: { label: "Runbook", defaultFile: "runbook.md", describes: "How to operate it: build, run, test, deploy, configure, and what to do when the common things break. Every command must be one that works." },
  refresh: { label: "Page", defaultFile: null, describes: "Existing pages that describe parts of the code. Bring each one in line with the code as it is now, and leave alone whatever is still true." },
  adr: { label: "Decision record", defaultFile: null, describes: "One architecture decision: the context, what was decided and what follows from it." },
};

export interface Target {
  /** Relative to the workspace. */
  path: string;
  exists: boolean;
  state?: Freshness | null;
  /** Files under the page's covers that changed since it was written (capped). */
  changed?: string[];
  changedTotal?: number;
}

export interface PromptInput {
  kind: GenKind;
  docsDir: string;
  targets: Target[];
  /** HEAD at launch: what the agent records as `generated.commit`. Null outside a git repository. */
  head: string | null;
  /** engine/model, recorded as `generated.by`. */
  by: string;
  /** The date the pages are stamped with. */
  at: string;
  /** Free text from the operator: the topic of a module page or an ADR, or extra instructions. */
  input?: string | null;
  refresh: boolean;
  /** A CodeGraph index exists here: say to start with it. */
  codegraph: boolean;
  /** Other pages already in the docs folder, so new ones link instead of repeating. */
  existing: string[];
  /** The agent already holds the conversation an ADR should capture. */
  inConversation?: boolean;
  /** The next ADR number, "0007". */
  nextAdr?: string;
  /** The plan questionnaire is on: write nothing until the plan is approved. */
  planFirst?: boolean;
}

const fence = "```";

function frontMatterExample(p: PromptInput): string {
  return [
    `${fence}yaml`,
    "---",
    "title: <a short title>",
    "covers:            # the paths this page describes: globs or directories, as precise as you can make them",
    "  - src/example/**",
    "generated:",
    p.head ? `  commit: ${p.head}` : "  commit: <leave out: this is not a git repository>",
    `  at: ${p.at}`,
    `  by: ${p.by}`,
    "status: draft",
    "---",
    fence,
  ].join("\n");
}

/** The rules every documentation run follows. */
export function contract(p: PromptInput): string {
  const lines = [
    "## How to write these pages",
    "",
    `1. Read the code before you write about it. ${p.codegraph ? "This project has a CodeGraph index: start with `codegraph_explore` and `codegraph_node`, then read the files that matter. " : ""}Every statement has to be something you saw in the repository. If you could not find out, say so in the page instead of guessing.`,
    `2. Write only inside \`${p.docsDir}/\`, and only markdown. Do not change source code, configuration or anything else, and do not run commands that modify the repository (no commits, no installs).`,
    "3. Every page you write or refresh starts with this front matter, with these exact values:",
    "",
    frontMatterExample(p),
    "",
    p.head ? `   \`commit\`, \`at\` and \`by\` are given to you: copy them as they are, do not run git to find them. \`covers\` is yours to set, and it matters: it is how the app later notices the page has drifted from the code, so list the real paths the page describes (not \`**\`).` : "   There is no git history here, so leave \`commit\` out. `covers` still matters: list the real paths the page describes.",
    "   Keep any other front matter keys a page already has, exactly as they are.",
    "4. Sections wrapped in `<!-- keep -->` … `<!-- /keep -->` were written by a person. Leave those blocks byte for byte as they are, in the same place. Everything else on a refreshed page is yours to revise.",
    "5. Be concrete and short: file and directory names in backticks, short sections, no filler, no marketing words. Link to other pages with relative links instead of repeating them.",
    "6. When you are done, end your reply with exactly one line, `DOCS_TOUCHED: ` followed by the pages you created or changed, comma separated, relative to the repository root. Nothing after it.",
  ];
  return lines.join("\n");
}

function targetLines(p: PromptInput): string[] {
  return p.targets.map((t) => {
    const bits: string[] = [t.exists ? "exists" : "to create"];
    if (t.state && t.state !== "unmanaged") bits.push(t.state);
    if (t.changedTotal) bits.push(`${t.changedTotal} covered file${t.changedTotal === 1 ? "" : "s"} changed since it was written`);
    const head = `- \`${t.path}\` (${bits.join(", ")})`;
    const files = (t.changed ?? []).slice(0, 25);
    return files.length ? `${head}\n  Changed: ${files.map((f) => `\`${f}\``).join(", ")}${t.changedTotal && t.changedTotal > files.length ? ", …" : ""}` : head;
  });
}

export function generationPrompt(p: PromptInput): string {
  const spec = KIND_SPECS[p.kind];
  const out: string[] = [];
  const verb = p.refresh ? "Refresh" : "Write";
  out.push(`# ${verb} documentation: ${spec.label}${p.targets.length > 1 ? "s" : ""}`, "");
  if (p.kind === "adr") {
    out.push(
      p.inConversation
        ? "Write a decision record for the decision this conversation reached. Use what was said here: the alternatives that were weighed, why one won, what it costs."
        : `Write a decision record${p.input ? ` for: ${p.input}` : ""}. Find the evidence for it in the code and its history (\`git log\` is allowed for reading), and do not invent a rationale: where the reason is not recorded, say that it is not.`,
      "",
      `Use the next number${p.nextAdr ? `, ${p.nextAdr}` : ""}: the file is \`${p.docsDir}/decisions/${p.nextAdr ?? "NNNN"}-<short-slug>.md\`. Sections, in order: Status (Proposed, Accepted, Superseded by …), Context, Decision, Consequences. Front matter for a decision record is just \`title\` and \`status\`; it makes no \`covers\` or \`generated\` claim.`,
    );
    if (p.input && p.inConversation) out.push("", `Focus: ${p.input}`);
  } else {
    out.push(`What a ${spec.label.toLowerCase()} page is: ${spec.describes}`, "");
    out.push(p.refresh ? "Pages to refresh:" : "Pages to write:", "", ...targetLines(p));
    if (p.refresh) {
      out.push(
        "",
        "For each page: read it first. Where the code under its `covers` changed, bring the page in line with the code as it is now. Where nothing changed, leave the text alone. Do not rewrite for style. Then set the front matter as described below.",
      );
    }
    if (p.input) out.push("", `Operator's note: ${p.input}`);
    if (p.existing.length) out.push("", `Other pages already in \`${p.docsDir}/\` (link to them, do not repeat them): ${p.existing.slice(0, 30).map((f) => `\`${f}\``).join(", ")}${p.existing.length > 30 ? ", …" : ""}.`);
  }
  out.push("", contract(p));
  if (p.planFirst) {
    out.push(
      "",
      "## Plan first",
      "",
      "Do not write anything yet. Read the code, ask the operator what you need to know with the plan tool, and submit the plan: which pages, what each will cover, which paths each will list in `covers`. You write the pages after the plan is approved, following the rules above.",
    );
  }
  return out.join("\n");
}

/** Pull the pages an agent says it touched out of its final reply. */
export function reportedTouched(output: string | null | undefined): string[] {
  const m = /^DOCS_TOUCHED:[ \t]*(.*)$/im.exec(String(output ?? ""));
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}
