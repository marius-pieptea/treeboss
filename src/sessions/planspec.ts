/**
 * A plan becoming a spec feature: the "Spec it" depth, and "Promote to spec" on a quick plan. It calls into
 * the specs module for numbering, the folder and the skeleton (createFeature, specTemplate), so a feature made
 * here is indistinguishable from one made in the Specs view, and the stepper picks up from there:
 *
 *   spec.md   the skeleton with what the plan knows filled in (Input = the summary, Assumptions = the user's
 *             decisions, Requirements and Success Criteria when the agent gave them, open questions as
 *             [NEEDS CLARIFICATION] markers). The user stories stay as the template's placeholders: the plan
 *             does not know them, so the spec reads as a draft and the Specify and Clarify steps stay open.
 *   plan.md   the plan itself (front matter + steps + files + risks), which the Plan step builds on.
 */
import fs from "fs";
import path from "path";
import { createFeature, listFeatures, type FeatureInfo } from "../specs/store";
import { specTemplate } from "../specs/templates";
import { safeJoin } from "../workspaces";
import { UserError } from "../util";
import { renderPlanBody, frontMatter, sha, type PlanContent, type PlanMeta } from "./planfile";

const pad = (n: number) => String(n).padStart(3, "0");

/** Replace the body of a markdown section (from its heading to the next heading of the same or higher level). */
export function replaceSection(text: string, heading: string, lines: string[]): string {
  const level = /^#+/.exec(heading)![0].length;
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return text;
  const bodyStart = start + heading.length + 2;
  const rest = text.slice(bodyStart);
  const next = new RegExp(`^#{1,${level}}\\s`, "m").exec(rest);
  const end = next ? bodyStart + next.index : text.length;
  return `${text.slice(0, bodyStart)}\n${lines.join("\n")}\n${end < text.length ? "\n" : ""}${text.slice(end)}`;
}

/** The spec.md for a feature, from the plan. */
export function specTextFromPlan(featureId: string, c: PlanContent): string {
  let t = specTemplate(c.title, c.summary || c.title, featureId);
  const fr: string[] = (c.requirements ?? []).map((r, i) => `- **FR-${pad(i + 1)}**: ${r}`);
  c.open_questions.slice(0, 3).forEach((q, i) => fr.push(`- **FR-${pad(fr.length + 1)}**: The system MUST [NEEDS CLARIFICATION: ${q.replace(/[\[\]\n]+/g, " ").trim()}]`));
  if (fr.length) t = replaceSection(t, "### Functional Requirements", fr);
  if (c.success_criteria?.length) t = replaceSection(t, "## Success Criteria", c.success_criteria.map((r, i) => `- **SC-${pad(i + 1)}**: ${r}`));
  if (c.decisions.length) t = replaceSection(t, "## Assumptions", c.decisions.map((d) => `- ${d}`));
  return t;
}

/** plan.md for a feature: front matter, the plan, and a project structure drawn from the files the steps touch. */
export function planTextForFeature(f: Pick<FeatureInfo, "id">, meta: PlanMeta, c: PlanContent): string {
  const body = renderPlanBody(c);
  const nl = body.indexOf("\n");
  const head = `${body.slice(0, nl + 1)}\n**Feature**: \`${f.id}\` | **Spec**: [spec.md](./spec.md)\n`;
  const files = [...new Set(c.steps.flatMap((s) => s.files ?? []))];
  const tail = files.length ? `\n## Project Structure\n\n\`\`\`text\n${files.join("\n")}\n\`\`\`\n` : "";
  return frontMatter(meta) + head + body.slice(nl + 1) + tail;
}

export interface SpecFeatureResult {
  feature: FeatureInfo;
  planPath: string;
  specPath: string;
  planSha: string;
  /** Null when spec.md was left alone. */
  specSha: string | null;
}

/** Create the feature folder (a free name: -2, -3… when the slug is taken) and write spec.md and plan.md. */
export function createSpecFeature(rootDir: string, meta: PlanMeta, c: PlanContent): SpecFeatureResult {
  let feature: FeatureInfo | null = null;
  for (let n = 1; n <= 9 && !feature; n++) {
    try {
      feature = createFeature(rootDir, { name: n === 1 ? c.title : `${c.title} ${n}`, description: c.summary || c.title });
    } catch (e: any) {
      if (!(e instanceof UserError) || !/already exists/.test(e.message) || n === 9) throw e;
    }
  }
  if (!feature) throw new UserError("Could not allocate a spec folder for this plan.");
  return writeSpecFeature(rootDir, feature, meta, c);
}

/** (Re)write the two files of an existing feature from the plan. */
export function writeSpecFeature(rootDir: string, feature: FeatureInfo, meta: PlanMeta, c: PlanContent, opts: { writeSpec?: boolean } = {}): SpecFeatureResult {
  const specPath = `${feature.dir}/spec.md`;
  const planPath = `${feature.dir}/plan.md`;
  const spec = specTextFromPlan(feature.id, c);
  const plan = planTextForFeature(feature, meta, c);
  fs.mkdirSync(path.dirname(safeJoin(rootDir, specPath)), { recursive: true });
  // spec.md belongs to whoever has been editing it since: a revision of the plan leaves it alone then.
  if (opts.writeSpec !== false) fs.writeFileSync(safeJoin(rootDir, specPath), spec);
  fs.writeFileSync(safeJoin(rootDir, planPath), plan);
  return { feature: listFeatures(rootDir).find((f) => f.id === feature.id) ?? feature, planPath, specPath, planSha: sha(plan), specSha: opts.writeSpec === false ? null : sha(spec) };
}
