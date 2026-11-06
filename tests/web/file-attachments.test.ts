import { describe, expect, test } from "bun:test";
import { fileRefusal, formatBytes, MAX_FILE_BYTES, MAX_MESSAGE_BYTES } from "../../web/src/features/context/logic";

describe("file attachments", () => {
  test("per-file and per-message limits, and sizes read well", () => {
    expect(fileRefusal({ name: "a.pdf", size: 1000 }, 0)).toBeNull();
    expect(fileRefusal({ name: "a.pdf", size: 0 }, 0)).toMatch(/empty/);
    expect(fileRefusal({ name: "a.zip", size: MAX_FILE_BYTES + 1 }, 0)).toMatch(/25 MB/);
    expect(fileRefusal({ name: "a.zip", size: MAX_FILE_BYTES }, MAX_MESSAGE_BYTES - 10)).toMatch(/75 MB/);
    expect([formatBytes(12), formatBytes(2048), formatBytes(3 * 1024 * 1024)]).toEqual(["12 B", "2 KB", "3.0 MB"]);
  });
});
