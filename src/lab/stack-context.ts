/**
 * The detected stack of a project, as a block every Lab pass prompt carries: what the files say the project is, the evidence
 * for it, and where its routes and markup live. The operator does not type it; it is read from the files (src/stack.ts).
 */
import { openRepo } from "../checklists/checks";
import { detectStack, STACK_HINTS } from "../stack";

export function stackContext(rootDir: string): string {
  const s = detectStack(openRepo(rootDir));
  const lines = [`Detected stack: ${s.stack}${s.templateExts.length ? ` (templates: ${s.templateExts.join(", ")})` : ""}.`, ...s.evidence.map((e) => `- ${e}`), `Where to look: ${STACK_HINTS[s.stack]}`];
  if (s.stack === "unknown") lines.push("The checks did not recognise the stack: read the code and say what you can show.");
  return lines.join("\n");
}
