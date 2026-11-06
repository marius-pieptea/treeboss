/**
 * The wrapper the daemon puts around attached context in a prompt (src/context/resolve.ts `withContext`), and the
 * split that lets the thread show only what the operator typed. No imports: the daemon's tests load it too.
 */
const CONTEXT_START = "<!-- trb:context -->\n";
const CONTEXT_END = "\n\n<!-- /trb:context -->\n\n---\n\n";

/**
 * A prompt the daemon prefixed with the chips the operator attached: the words they typed, and the attached
 * text, which the thread folds away. Plain prompts come back unchanged.
 */
export function splitContext(text: string): { text: string; context: string | null } {
  if (!text.startsWith(CONTEXT_START)) return { text, context: null };
  const end = text.indexOf(CONTEXT_END, CONTEXT_START.length);
  if (end < 0) return { text, context: null };
  return { text: text.slice(end + CONTEXT_END.length), context: text.slice(CONTEXT_START.length, end) };
}
