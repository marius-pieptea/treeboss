/**
 * Files attached to a message (anything but a plain image, which keeps its own store in images.ts).
 *
 * Stored under `<trb home>/context-files/<id>/`: the original as `original/<safe name>`, and what we derive
 * from it next to it (`extracted.txt`, `unpacked/`). Never inside a repo. The type is decided by magic bytes
 * and the extension, not by what the browser claimed; a file that is none of the supported kinds is refused
 * at upload. Everything after upload (parsing, unpacking) is best effort: a failure becomes a one-line note
 * in the prompt and never fails the send.
 *
 * Cleanup: entries here and in context-images are deleted when they have not been used for
 * `RETENTION_DAYS` days (use = upload or being attached to a message). The sweep runs at most once an hour,
 * piggybacked on uploads. A session that outlives that window sees "no longer stored" notes.
 */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { home } from "../paths";
import { saveImage, sniffImage } from "./images";
import { extractZip, readEntry, readZip, ZipError, type Extracted } from "./zip";
import { htmlToText } from "./url";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** What one message may carry in attached files altogether. */
export const MAX_MESSAGE_BYTES = 75 * 1024 * 1024;
export const RETENTION_DAYS = 30;
/** Cap on stored extracted text (a safety net; the prompt gets far less). */
const MAX_EXTRACT_CHARS = 2_000_000;

export type FileKind = "text" | "html" | "pdf" | "docx" | "zip";

export class FileError extends Error {}

export interface StoredFile {
  id: string;
  kind: FileKind | "image";
  name: string;
  bytes: number;
}

const root = () => {
  const d = path.join(home(), "context-files");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return path.resolve(d);
};

/** The name as it is stored: the last path segment, no control characters, bounded. Only for display on disk. */
export function safeName(name: string): string {
  const base = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_").replace(/^\.+/, "_").trim().slice(0, 120);
  return clean || "file";
}

const extOf = (name: string) => path.extname(name).slice(1).toLowerCase();

/** Valid UTF-8 without NUL bytes: what we are willing to call text. */
function looksText(b: Buffer): boolean {
  const head = b.subarray(0, 64 * 1024);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.length < b.length ? head.subarray(0, head.length - 3) : head);
    return true;
  } catch {
    return false;
  }
}

/** Decide what a file is, or throw. Magic bytes first, the extension second, a text sniff last. */
export function detectKind(name: string, data: Buffer): FileKind {
  const ext = extOf(name);
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const zip = data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
  const emptyZip = data.length >= 22 && data.readUInt32LE(0) === 0x06054b50;
  if (zip || emptyZip) {
    if (ext === "docx") return "docx";
    if (ext === "zip" || ext === "jar" || ext === "") return "zip";
    if (["xlsx", "pptx", "odt", "ods", "odp", "epub", "apk"].includes(ext)) throw new FileError(`.${ext} files are not supported yet (zip it and attach the .zip, or export to text).`);
    return "zip";
  }
  if (ext === "pdf") throw new FileError("That file is named .pdf but is not a PDF.");
  if (ext === "docx" || ext === "zip") throw new FileError(`That file is named .${ext} but is not a valid ${ext === "zip" ? "zip archive" : "Word document"}.`);
  if (ext === "doc") throw new FileError("Old .doc files are not supported; save as .docx or PDF.");
  if (!looksText(data)) throw new FileError("That file type is not supported (binary content). PDFs, Word .docx, zip archives, images and text or code files can be attached.");
  if (ext === "html" || ext === "htm" || ext === "xhtml") return "html";
  // Known extensions and extensionless names (Makefile) are text by habit; anything else that decodes as UTF-8 is too.
  return "text";
}

let lastSweep = 0;
export function sweepOld(now = Date.now(), maxAgeDays = RETENTION_DAYS): number {
  let n = 0;
  const cutoff = now - maxAgeDays * 86_400_000;
  for (const d of [root(), path.join(home(), "context-images")]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(d);
    } catch {}
    for (const nm of names) {
      const p = path.join(d, nm);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) {
          fs.rmSync(p, { recursive: true, force: true });
          n++;
        }
      } catch {}
    }
  }
  return n;
}

/** Validate and store one uploaded file. Images are handed to the image store and keep their own ids. */
export function saveUpload(name: string, data: Buffer): StoredFile {
  if (data.length === 0) throw new FileError("That file is empty.");
  if (data.length > MAX_FILE_BYTES) throw new FileError(`Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const display = safeName(name);
  if (sniffImage(data)) {
    const img = saveImage(data); // throws an ImageError (8 MB cap) the route reports
    return { id: img.id, kind: "image", name: display, bytes: img.bytes };
  }
  const kind = detectKind(display, data);
  if (Date.now() - lastSweep > 3_600_000) {
    lastSweep = Date.now();
    try {
      sweepOld();
    } catch {}
  }
  const id = `fil_${randomBytes(8).toString("hex")}`;
  const dir = path.join(root(), id);
  fs.mkdirSync(path.join(dir, "original"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "original", display), data, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ name: display, kind, bytes: data.length, at: Date.now() }));
  return { id, kind, name: display, bytes: data.length };
}

export interface FileMeta {
  id: string;
  name: string;
  kind: FileKind;
  bytes: number;
  dir: string;
  /** Absolute path of the stored original. */
  file: string;
}

/** The stored file for an id, or null. The id shape is checked so it can never be a path. */
export function storedFile(id: string): FileMeta | null {
  if (!/^fil_[0-9a-f]{16}$/.test(id)) return null;
  const dir = path.join(root(), id);
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"));
    const file = path.join(dir, "original", safeName(m.name));
    if (!fs.existsSync(file)) return null;
    const now = new Date();
    fs.utimesSync(dir, now, now); // used just now: the retention clock restarts
    return { id, name: m.name, kind: m.kind, bytes: m.bytes, dir, file };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ extraction */

export async function pdfText(data: Buffer): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const run = (async () => {
    const doc = await getDocumentProxy(new Uint8Array(data));
    const r = await extractText(doc, { mergePages: true });
    return { text: String(r.text ?? ""), pages: r.totalPages };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new FileError("took too long to read")), 30_000)));
  try {
    return await Promise.race([run, limit]);
  } finally {
    clearTimeout(timer);
  }
}

const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (XML_ENT[e.toLowerCase()] ?? "")));

export function docxText(data: Buffer): string {
  const xml = readEntry(data, "word/document.xml");
  if (!xml) throw new FileError("no word/document.xml: not a Word document");
  return unent(
    xml
      .toString("utf-8")
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<(?!\/?w:t[ >])[^>]*>/g, "")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Write the derived text next to the original and return its path (idempotent). */
function writeExtract(f: FileMeta, text: string): string {
  const p = path.join(f.dir, "extracted.txt");
  fs.writeFileSync(p, text.slice(0, MAX_EXTRACT_CHARS), { mode: 0o600 });
  return p;
}

export interface Described {
  /** One sentence naming the file and where it lives. */
  header: string;
  /** Text to show inline (already capped to `room`), or null. */
  inline: string | null;
  lang?: string;
  /** Extra sections to show after the inline text, already formatted. */
  more?: string;
  cut: boolean;
  /** Characters used. */
  chars: number;
}

const treeOf = (files: Array<{ path: string; bytes: number }>, max = 200): string => {
  const lines = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}  (${f.bytes < 1024 ? `${f.bytes} B` : `${Math.round(f.bytes / 1024)} KB`})`);
  return lines.length > max ? [...lines.slice(0, max), `… and ${lines.length - max} more files`].join("\n") : lines.join("\n");
};

const SKIP_INLINE = /(^|\/)(node_modules|\.git|dist|build|\.next|vendor|__pycache__)\//;
const INLINE_FILE_BYTES = 12 * 1024;
const MAX_INLINE_FILES = 8;

function zipSummary(f: FileMeta, room: number): { body: string; chars: number; cut: boolean } {
  const dest = path.join(f.dir, "unpacked");
  let ex: Extracted;
  const marker = path.join(f.dir, "unpacked.json");
  if (fs.existsSync(marker)) ex = JSON.parse(fs.readFileSync(marker, "utf-8"));
  else {
    fs.rmSync(dest, { recursive: true, force: true });
    ex = extractZip(fs.readFileSync(f.file), dest);
    fs.writeFileSync(marker, JSON.stringify(ex));
  }
  const parts: string[] = [`Unpacked into: ${dest}`, `Contains ${ex.files.length} file${ex.files.length === 1 ? "" : "s"}, ${Math.round(ex.totalBytes / 1024)} KB. Read what you need from there with your file tools.`, "", "File tree:", fence(treeOf(ex.files))];
  if (ex.refused.length) parts.push("", `Not unpacked (${ex.refused.length}): ${ex.refused.slice(0, 10).map((r) => `${r.name} (${r.why})`).join("; ")}${ex.refused.length > 10 ? "; …" : ""}`);
  let used = parts.join("\n").length;
  let cut = false;
  // Small text files, README-ish first, inline within what is left of the budget.
  const rank = (p: string) => (/^readme/i.test(path.basename(p)) ? 0 : /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(path.basename(p)) ? 1 : 2);
  const cands = ex.files.filter((x) => x.bytes > 0 && x.bytes <= INLINE_FILE_BYTES && !SKIP_INLINE.test(x.path)).sort((a, b) => rank(a.path) - rank(b.path) || a.bytes - b.bytes);
  let n = 0;
  for (const c of cands) {
    if (n >= MAX_INLINE_FILES) break;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(dest, c.path));
    } catch {
      continue;
    }
    if (!looksText(buf)) continue;
    const block = `\n\n### ${c.path}\n\n${fence(buf.toString("utf-8"))}`;
    if (used + block.length > room) {
      cut = true;
      break;
    }
    parts.push(block);
    used += block.length;
    n++;
  }
  if (cands.length > n) cut = true;
  return { body: parts.join("\n"), chars: used, cut };
}

/** A fence longer than any run of backticks inside. */
function fence(content: string, lang = ""): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${content.replace(/\n$/, "")}\n${f}`;
}

const capTo = (t: string, n: number) => (t.length > n ? { text: t.slice(0, Math.max(0, n)), cut: true } : { text: t, cut: false });

/**
 * Turn a stored file into the text a prompt carries. `room` is how many characters this file may take.
 * Throws for anything that cannot be read; the caller turns that into a note.
 */
export async function describeFile(f: FileMeta, room: number, perFile: number): Promise<{ markdown: string; chars: number; cut: boolean }> {
  const budget = Math.max(0, Math.min(room, perFile));
  const data = f.kind === "zip" ? null : fs.readFileSync(f.file);
  const head = `${f.kind.toUpperCase()} file ${f.name} (${f.bytes < 1024 * 1024 ? `${Math.max(1, Math.round(f.bytes / 1024))} KB` : `${(f.bytes / 1024 / 1024).toFixed(1)} MB`}). Original saved at: ${f.file}`;
  switch (f.kind) {
    case "text": {
      const c = capTo(data!.toString("utf-8"), budget);
      return { markdown: `${head}\n\n${fence(c.text, extOf(f.name))}`, chars: c.text.length, cut: c.cut };
    }
    case "html": {
      const src = data!.toString("utf-8");
      const text = htmlToText(src);
      const ep = writeExtract(f, text);
      const half = Math.floor(budget / 2);
      const t = capTo(text, half);
      const s = capTo(src, budget - t.text.length);
      return { markdown: `${head}\nText-only version saved at: ${ep}\n\nText of the page:\n\n${fence(t.text)}\n\nHTML source:\n\n${fence(s.text, "html")}`, chars: t.text.length + s.text.length, cut: t.cut || s.cut };
    }
    case "pdf": {
      const r = await pdfText(data!);
      const text = r.text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (!text) return { markdown: `${head}\n${r.pages} page${r.pages === 1 ? "" : "s"}, but no extractable text (a scan?). Open the original if your tools can read PDFs.`, chars: 0, cut: false };
      const ep = writeExtract(f, text);
      const c = capTo(text, budget);
      return { markdown: `${head}\n${r.pages} page${r.pages === 1 ? "" : "s"}. Full extracted text saved at: ${ep}${c.cut ? " (read it for the rest)" : ""}\n\n${fence(c.text)}`, chars: c.text.length, cut: c.cut };
    }
    case "docx": {
      const text = docxText(data!);
      if (!text) return { markdown: `${head}\nThe document has no text.`, chars: 0, cut: false };
      const ep = writeExtract(f, text);
      const c = capTo(text, budget);
      return { markdown: `${head}\nFull extracted text saved at: ${ep}${c.cut ? " (read it for the rest)" : ""}\n\n${fence(c.text)}`, chars: c.text.length, cut: c.cut };
    }
    case "zip": {
      try {
        readZip(fs.readFileSync(f.file));
      } catch (e) {
        if (e instanceof ZipError) throw new FileError(e.message);
        throw e;
      }
      const z = zipSummary(f, budget);
      return { markdown: `${head}\n\n${z.body}`, chars: z.chars, cut: z.cut };
    }
  }
}
