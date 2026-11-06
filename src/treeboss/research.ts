/**
 * Research before building a new product area (treeboss mode's "area" tier). The agent finds the products that do
 * the feature well, the operator picks one, and only then is that one reverse-engineered and built to the evidence.
 *
 * RESEARCH_RULES is what the agent is told before the pick; AFTER_RESEARCH_PICK is what it is told when the pick
 * arrives. The product-teardown skill (skills/builtin.ts) carries both, so the two never drift. The page and the
 * stop-for-pick step mirror design/guidance.ts (DIRECTIONS_PAGE, then AFTER_PICK).
 */
import { DESIGN_FILE, TOKENS_FILE } from "../design/contract";

export const CANDIDATES_FILE = "research/candidates.html";

/** Before the pick: find the candidates, write the page, and stop. */
export const RESEARCH_RULES = `Before building a new product area, find out how products that do this well already work, and let the operator pick the one to learn from.

1. **Search.** Search the web for products that do this feature well, not just products in the category. Prefer ones with a public web app, since they are the easiest to inspect; note any that need an installed app, a login or a store listing.
2. **Compare.** Write ONE self-contained static HTML file at ${CANDIDATES_FILE} (inline CSS, no JavaScript, no external requests) with two or three candidates labelled A, B and C. For each: name, URL, what it does well for THIS feature, how inspectable it is (public web app, Electron, mobile, or needs a login), what we would take (behavior, structure, flows) and what we would not (branding, assets, copy). Mark the one you recommend.
3. **Stop.** Reply with the candidates in one sentence each, your recommendation, and ask which one to learn from. Then wait for the operator's pick. Do not start an investigation, write a spec or build anything in this turn.
4. **After the pick**, follow the steps under "After the pick" below.`;

/** After the pick: reverse-engineer the chosen product with the evidence tools, spec it, build it, and clean up. */
export const AFTER_RESEARCH_PICK = `When the operator replies with a pick (a letter, or a letter with changes), do these steps in order:
1. **Investigate.** Call investigation_list first: if the picked product was studied before, reuse that investigation (evidence_list with its id). Otherwise call investigation_start with the product as the target and target_kind web, electron, binary, android or other.
2. **Capture.** For a web target, browse to each page that shows the feature (one per distinct state: an error, an empty list, an opened menu) and call evidence_capture_page for each. Do not capture pages behind the operator's login unless they asked. For an Electron app, an APK or a binary, use the REA tools (for example inspect_electron_page, inspect_android_package or binary_overview) and save each result that matters with evidence_save_result, keeping its evidence and limits.
3. **Read and note.** Read what you captured with evidence_read (parts styles, snapshot and assets, and the screenshot). Write one evidence_note per conclusion, citing the captures in refs, and say what you could not verify.
4. **Record.** Record each feature with evidence_finding and kind "feature", and each UI design with kind "ui", citing the captures and saved results it rests on. One finding per feature or design.
5. **Spec and build.** Write the spec from the findings: the behaviors, flows and screens to build, and what is still unknown. Then build it to that evidence in this project, following ${DESIGN_FILE} and ${TOKENS_FILE}: map every measured value to a token (add a missing one to both files first), and use none of the picked product's logos, names, copy, illustrations or proprietary fonts. Mark each finding you build with evidence_set_status "built".
6. **Clean up.** Delete ${CANDIDATES_FILE}: it was for choosing, not for keeping. Close the investigation with investigation_close, with a summary of what was found, what is still unknown and what was built.`;
