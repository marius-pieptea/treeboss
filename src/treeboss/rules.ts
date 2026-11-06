/**
 * What a session in treeboss mode is told: once per engine conversation, and again when it was switched on.
 * gate.ts checks the same rules after each turn, so a change here goes with a change there.
 */
import { CONSTITUTION_PATH, SPECS_DIR } from "../specs/templates";
import { AFTER_RESEARCH_PICK, RESEARCH_RULES } from "./research";

export const TREEBOSS_BLOCK = `# Treeboss mode

This session works the treeboss way. After each turn a gate checks the rules below against the files that turn changed.

1. **Triage.** Start every task by stating its tier on its own line: \`TREEBOSS_TIER: tweak\`, \`TREEBOSS_TIER: feature\` or \`TREEBOSS_TIER: area\`.
   - tweak: a fix, a rename, or a small change to something that exists.
   - feature: new behavior in an existing area.
   - area: a new product area that the repository does not have yet.
2. **Design, all tiers.** Before any UI change, read DESIGN.md and design/tokens.css. Use only their tokens: no raw hex colors, no sizes they do not define. If a token you need is missing, add it to both files first.
3. **Spec, feature and area.** Write the spec with the \`spec_new\` tool: give it a name and a description of what the feature does. It creates ${SPECS_DIR}/NNN-name/spec.md from the template and returns its path. Fill that file in, then attach it to this session with \`spec_attach\` (its path). The constitution is ${CONSTITUTION_PATH}. Read it first and do not contradict it. If it does not exist, say so in your reply rather than writing one by hand.
4. **Roadmap, feature and area.** Propose an item with the \`roadmap_propose\` tool: its title, the spec path as \`spec\`, and \`docs\` when the change updates a docs page. It adds an unchecked item to the first lane (or the one named Proposed), and it creates ROADMAP.md when the project has none. Leave the item unchecked: \`- [x]\` means shipped, and you never mark anything shipped.
5. **Docs, feature and area.** Update the docs this change affects: the docs folder (docs/ unless the workspace says otherwise), or the root README.md or another root *.md that now describes the old behavior.
6. **Area only.** Research before you build. Stop for the operator's pick, and build nothing until they make it.

Each step is a rule the gate checks. If one does not apply to this change, say why in your reply.`;

/**
 * The block the engine gets. The area tier's research steps go on the end, with the "After the pick" steps under them:
 * RESEARCH_RULES tells the agent to follow those steps when the operator replies, so they must already be in context.
 */
export function treebossBlock(): string {
  if (!RESEARCH_RULES) return TREEBOSS_BLOCK;
  const afterPick = AFTER_RESEARCH_PICK ? `\n\n### After the pick\n\n${AFTER_RESEARCH_PICK}` : "";
  return `${TREEBOSS_BLOCK}\n\n## Area: research first\n\n${RESEARCH_RULES}${afterPick}`;
}
