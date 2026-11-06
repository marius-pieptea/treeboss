/**
 * Encryption of stored secret values: AES-256-GCM under one master key kept in the TRB home.
 *
 * The key is 32 random bytes, created on first use with 0600 permissions and never leaves the daemon. Each
 * value gets its own 12-byte IV. The caller passes an associated-data string (workspace, environment, name),
 * so a ciphertext copied onto another row fails to open instead of quietly yielding the wrong value.
 *
 * Nothing here logs or returns a plaintext except `open`, whose caller is the server side only.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { home } from "../paths";

const ALG = "aes-256-gcm";
const FORMAT = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cached: { file: string; key: Buffer } | null = null;

/** Where the master key lives. A function so tests that repoint TRB_HOME get their own key. */
export function keyFile(): string {
  return path.join(home(), "secrets.key");
}

function readKey(file: string): Buffer | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error(`${file} is not a valid key. Restore it from a backup: without it the stored secrets cannot be read.`);
  return key;
}

export function masterKey(): Buffer {
  const file = keyFile();
  if (cached?.file === file) return cached.key;
  let key = readKey(file);
  if (!key) {
    const fresh = crypto.randomBytes(KEY_BYTES);
    try {
      // "wx": never replace a key that appeared between the read and the write.
      fs.writeFileSync(file, fresh.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
      key = fresh;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      key = readKey(file)!;
    }
  }
  cached = { file, key };
  return key;
}

/** Encrypt one value. The result is a self-contained string: format, IV, tag and ciphertext. */
export function seal(plain: string, aad: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, masterKey(), iv);
  cipher.setAAD(Buffer.from(aad, "utf-8"));
  const body = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  return `${FORMAT}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

/** Decrypt one value. Throws without the plaintext or any part of it if the data or associated data do not match. */
export function open(sealed: string, aad: string): string {
  const sep = sealed.indexOf(":");
  const buf = sealed.slice(0, sep) === FORMAT ? Buffer.from(sealed.slice(sep + 1), "base64") : null;
  if (!buf || buf.length < IV_BYTES + TAG_BYTES) throw new Error("A stored secret has an unknown format.");
  try {
    const decipher = crypto.createDecipheriv(ALG, masterKey(), buf.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(aad, "utf-8"));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf-8");
  } catch {
    throw new Error("A stored secret could not be decrypted (the master key or the stored data does not match).");
  }
}
