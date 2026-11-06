/**
 * Whether a session's model may be changed between turns. Kept free of the session manager so the view can ask.
 */
import { getEngine } from "../engines/registry";
import { HydraPairs } from "../hydra/pairs";

export function modelLock(s: { engine: string; pair_id: string | null; status: string }): string | null {
  if (s.status === "closed") return "This session is closed.";
  // A pair owns its models: the lead asks the operator before changing them (see assertWithinPair).
  if (s.pair_id && HydraPairs.get(s.pair_id)) return "Set by the pair";
  const def = getEngine(s.engine);
  if (def && def.modelOnResume === false) return "This engine keeps its model for the whole session";
  return null;
}
