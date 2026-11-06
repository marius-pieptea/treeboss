/**
 * Images pasted or dropped into the composer. Stored under the daemon's home (never inside a repo), named
 * by a random id, and handed to the engine as an absolute path: every engine that can read an image reads
 * it from disk, and one that cannot at least names it.
 */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { home } from "../paths";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const TYPES: Array<{ ext: string; mime: string; test: (b: Buffer) => boolean }> = [
  { ext: "png", mime: "image/png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", mime: "image/gif", test: (b) => b.length > 6 && /^GIF8[79]a/.test(b.subarray(0, 6).toString("latin1")) },
  { ext: "webp", mime: "image/webp", test: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** Does this look like one of the image types we store? */
export const sniffImage = (b: Buffer): boolean => TYPES.some((x) => x.test(b));

export class ImageError extends Error {}

const dir = () => {
  const d = path.join(home(), "context-images");
  fs.mkdirSync(d, { recursive: true });
  return path.resolve(d);
};

/** Validate by magic bytes (the claimed type is not trusted) and save. */
export function saveImage(data: Buffer): { id: string; file: string; mime: string; bytes: number } {
  if (data.length > MAX_IMAGE_BYTES) throw new ImageError(`Images are limited to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  const t = TYPES.find((x) => x.test(data));
  if (!t) throw new ImageError("Only PNG, JPEG, GIF and WebP images can be attached.");
  const id = `img_${randomBytes(8).toString("hex")}`;
  const file = path.join(dir(), `${id}.${t.ext}`);
  fs.writeFileSync(file, data, { mode: 0o600 });
  return { id, file, mime: t.mime, bytes: data.length };
}

/** The stored file for an id, or null. The id shape is checked so it can never be a path. */
export function imageFile(id: string): { file: string; mime: string } | null {
  if (!/^img_[0-9a-f]{16}$/.test(id)) return null;
  for (const t of TYPES) {
    const file = path.join(dir(), `${id}.${t.ext}`);
    if (fs.existsSync(file)) return { file, mime: t.mime };
  }
  return null;
}
