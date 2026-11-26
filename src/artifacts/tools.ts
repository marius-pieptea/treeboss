/**
 * Executor for the artifact_read MCP tool.
 */
import fs from "fs";
import { UserError } from "../util";
import { artifactIdFromUrl } from "./capture";
import { ARTIFACT_TOOL_SET } from "./defs";
import { isReading, readArtifact, waitForRead } from "./reader";
import { addPasted, getArtifact } from "./store";

export { ARTIFACT_TOOL_SET };

export interface ToolResult {
  text: string;
}

const MAX_INLINE_HTML_CHARS = 4000;

export async function executeArtifactTool(
  name: string,
  args: Record<string, unknown>,
  _caller: { sessionId: string },
): Promise<ToolResult> {
  try {
    if (!ARTIFACT_TOOL_SET.has(name)) return { text: `Error: unknown artifact tool "${name}".` };
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) return { text: "Error: url is required." };
    const id = artifactIdFromUrl(url);
    if (!id) return { text: "Error: Paste a link that starts with claude.ai/artifact/." };

    const item = addPasted(url);
    const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : undefined;
    const updated =
      (isReading(item.id) ? await waitForRead(item.id) : await readArtifact(item.id, { prompt })) ??
      getArtifact(item.id);
    if (!updated) return { text: `Error: artifact "${item.id}" not found.` };

    if (updated.error) {
      return { text: `Error: ${updated.errorText || updated.error}` };
    }
    if (updated.htmlPath && fs.existsSync(updated.htmlPath)) {
      const content = fs.readFileSync(updated.htmlPath, "utf-8");
      const kb = Math.round(Buffer.byteLength(content, "utf-8") / 1024);
      return {
        text: `Saved ${updated.htmlPath} (${kb} KB). It is self-contained HTML.\n\n${content.slice(0, MAX_INLINE_HTML_CHARS)}`,
      };
    }
    if (updated.summary !== null) {
      return { text: `Summary: ${updated.summary}` };
    }
    return { text: "Error: Failed to read artifact." };
  } catch (err: any) {
    if (err instanceof UserError) return { text: `Error: ${err.message}` };
    return { text: `Error: ${String(err?.message ?? err).split("\n")[0]}` };
  }
}
