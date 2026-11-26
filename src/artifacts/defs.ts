/**
 * The artifact_read tool definition, separate from its executor so the MCP shim can list it lightly.
 */
export const ARTIFACT_TOOL_NAMES = ["artifact_read"] as const;
export type ArtifactToolName = (typeof ARTIFACT_TOOL_NAMES)[number];
export const ARTIFACT_TOOL_SET = new Set<string>(ARTIFACT_TOOL_NAMES);

export function artifactToolDefs() {
  return [
    {
      name: "artifact_read",
      description:
        "Read a claude.ai artifact by its URL. For your own artifacts it saves the HTML and returns its path; for artifacts shared with you it returns a summary.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The claude.ai artifact URL (https://claude.ai/artifact/... or https://claude.ai/code/artifact/...).",
          },
          prompt: {
            type: "string",
            description: "Optional prompt to steer the summary for shared artifacts.",
          },
        },
        required: ["url"],
      },
    },
  ];
}
