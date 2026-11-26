/**
 * Executor for the artifact_read MCP tool.
 */
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { artifactIdFromUrl } from "./capture";
import { ARTIFACT_TOOL_SET } from "./defs";
import { isReading, readArtifact, waitForRead } from "./reader";
import { addPasted, getArtifact, listArtifactFiles } from "./store";

export { ARTIFACT_TOOL_SET };

export interface ToolResult {
  text: string;
}

const MAX_INLINE_HTML_CHARS = 20_000;
const MAX_INLINE_MD_CHARS = 40_000;
const MAX_INLINE_INDEX_CHARS = 20_000;
const MAX_OTHER_INDEX_BYTES = 64 * 1024;
const FILES_TRUNCATED_MARKER = ".files-truncated";

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
      if (updated.error === "usage_limit") {
        return {
          text: "Error: Claude's usage limit is reached, so artifacts can't be read right now. artifact_read runs Claude Code on the owner's subscription; try again after the limit resets.",
        };
      }
      if (updated.error === "not_signed_in") {
        return {
          text: "Error: Claude Code is not signed in to claude.ai, so artifacts can't be read.",
        };
      }
      return { text: `Error: ${updated.errorText || updated.error}` };
    }

    if (updated.contentKind === "markdown" && updated.contentPath && fs.existsSync(updated.contentPath)) {
      const md = fs.readFileSync(updated.contentPath, "utf-8");
      const header = `Claude Docs document "${updated.title}", saved as ${updated.contentPath}.`;
      if (md.length > MAX_INLINE_MD_CHARS) {
        return {
          text: `${header}\n\n${md.slice(0, MAX_INLINE_MD_CHARS)}\n\n[Truncated at ${MAX_INLINE_MD_CHARS} of ${md.length} chars. Read ${updated.contentPath} for the full document.]`,
        };
      }
      return { text: `${header}\n\n${md}` };
    }

    if (updated.contentKind === "files" && updated.contentPath && fs.existsSync(updated.contentPath)) {
      const files = listArtifactFiles(updated.contentPath);
      const typeLabel = updated.typeName || "files";
      const lines = [
        `Artifact of type "${typeLabel}" with ${files.length} files saved under ${updated.contentPath}:`,
        ...files.map((f) => `- ${f.path} (${f.size} bytes)`),
      ];
      if (fs.existsSync(path.join(path.dirname(updated.contentPath), FILES_TRUNCATED_MARKER))) {
        lines.push("Only the first 300 files were read.");
      }
      const indexFile =
        files.find((f) => f.path === "project/canvas.json") ??
        files.find((f) => path.posix.basename(f.path) === "canvas.json" && f.size < MAX_OTHER_INDEX_BYTES) ??
        files.find((f) => f.path.endsWith(".json") && f.size < MAX_OTHER_INDEX_BYTES);
      if (indexFile) {
        const indexAbs = path.join(updated.contentPath, ...indexFile.path.split("/"));
        if (fs.existsSync(indexAbs)) {
          const rawIndex = fs.readFileSync(indexAbs, "utf-8");
          const indexText =
            rawIndex.length > MAX_INLINE_INDEX_CHARS
              ? `${rawIndex.slice(0, MAX_INLINE_INDEX_CHARS)}\n[truncated]`
              : rawIndex;
          lines.push("", `${indexFile.path}:`, indexText);
        }
      }
      lines.push("", "Read the files with your file tool.");
      return { text: lines.join("\n") };
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
