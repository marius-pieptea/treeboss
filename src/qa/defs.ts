/**
 * The QA tools' definitions, apart from their executors so the MCP shim can list them without loading the browser
 * machinery. The trb MCP server offers them when the run carries TRB_QA (mcp/store.ts), which the session manager sets
 * for a session registered as an explore, run or map session (registry.ts). Descriptions are the agent's only manual.
 */
export const QA_TOOL_NAMES = ["qa_record", "bug_log"] as const;
export const QA_TOOL_SET: ReadonlySet<string> = new Set(QA_TOOL_NAMES);

export const BUG_KIND_LIST = ["functional", "visual", "logic", "content", "performance"] as const;

export function qaToolDefs() {
  return [
    {
      name: "qa_record" as const,
      description:
        "Record the outcome of one step of the QA run you are walking: pass, fail, blocked or skip. Record each step right after you try it, in order. " +
        "fail needs actual (what happened) and bug: the id bug_log returned, or the id of an open bug that is the same problem. blocked and skip need a note saying why. " +
        "Recording a step again replaces its outcome.",
      inputSchema: {
        type: "object" as const,
        properties: {
          step: { type: "string", description: "The step id from the run prompt, such as s-7k2p." },
          state: { type: "string", enum: ["pass", "fail", "blocked", "skip"], description: "pass: it did what it expects. fail: it did not. blocked: you could not try it. skip: it does not apply now." },
          note: { type: "string", description: "What you saw (pass), or why (blocked, skip). One or two sentences." },
          actual: { type: "string", description: "fail only: what happened instead of the expected result." },
          bug: { type: "string", description: "fail only: the bug's id, such as bug-cart-total-is-wrong." },
        },
        required: ["step", "state"],
      },
    },
    {
      name: "bug_log" as const,
      description:
        "Log a bug you found in the app, as a finding in the project's Bugs list. Call it while the problem is on screen in your browser: it takes a screenshot of the page you are on and keeps the browser console and the dev server log with it. " +
        "One call per distinct problem. If it looks like a bug that is already open, nothing is logged and that bug's id comes back: use it. When you are sure it is a different problem, call again with new: true. " +
        "The bug starts unconfirmed: a person confirms it before it is fixed. Returns the bug id to pass to qa_record.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "What is broken, in one line a person would understand: 'Cart total ignores the discount code'." },
          kind: { type: "string", enum: [...BUG_KIND_LIST], description: "functional: something does not work; visual: layout or styling; logic: wrong data or result; content: copy, text, images; performance: slow or janky. Default functional." },
          steps: { type: "array", items: { type: "string" }, description: "The steps to reproduce from a fresh start, one action per line, without numbers (up to 50)." },
          expected: { type: "string", description: "What should have happened." },
          actual: { type: "string", description: "What happened instead, with the exact text of any error." },
          screenshot: { type: "boolean", description: "Attach a screenshot of the current page (default true)." },
          new: { type: "boolean", description: "Log it even though it looks like an open bug: you checked and it is a different problem." },
        },
        required: ["title", "steps", "actual"],
      },
    },
  ];
}
