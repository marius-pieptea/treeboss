/** Definitions of the devserver_* tools, apart from their executors so the MCP shim stays light. */
export const DEVSERVER_TOOL_NAMES = ["devserver_logs", "preview_console"] as const;
export const DEVSERVER_TOOL_SET = new Set<string>(DEVSERVER_TOOL_NAMES);

export function devserverToolDefs() {
  return [
    {
      name: "devserver_logs",
      description:
        "Read the recent output of the app's dev server (or a database task) that the operator started from the Run panel for THIS working directory, with its status and URL. Read-only; you cannot start or stop it. Use it to see why the app fails to build or crash.",
      inputSchema: { type: "object", properties: { service: { type: "string", description: "Which one (default: the running dev server)." }, lines: { type: "number", description: "How many trailing lines (default 80, max 400)." } } },
    },
    {
      name: "preview_console",
      description:
        "Read console errors, warnings, uncaught exceptions and failed network requests the operator's live preview recorded (only while Inspect is on in the Browser tab). Set clear to empty the log after reading.",
      inputSchema: { type: "object", properties: { level: { type: "string", enum: ["all", "error", "warning", "failed-request"] }, clear: { type: "boolean" } } },
    },
  ];
}
