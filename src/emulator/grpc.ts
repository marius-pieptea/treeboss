/**
 * The emulator's own control channel. Booted with `-grpc <port> -grpc-use-token`, the emulator serves gRPC on
 * localhost and advertises the port and a per-run token in a discovery file (`avd/running/pid_<pid>.ini`). Over it
 * a touch or a key takes well under a millisecond, where each `adb shell input` costs 60-170 ms, and the screen is
 * pushed whenever it changes instead of being polled with screencap.
 *
 * Only the few messages treeboss sends are spoken, hand-encoded, over node:http2: no generated code, no dependency.
 * The emulator's API is emulator/lib/emulator_controller.proto in the SDK.
 */
import fs from "fs";
import http2 from "http2";
import os from "os";
import path from "path";
import { pngSize } from "./adb";
import type { Frame, LiveChannel } from "./transport";
import type { EmulatorKey } from "./types";

const SERVICE = "/android.emulation.control.EmulatorController/";
const STATUS_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 5000;

export class GrpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/* ---- protobuf: varints, strings and nested messages, which is all these messages use ---- */

type Value = number | string | Uint8Array | undefined;

/** A message from its fields, by number. Zero numbers and empty strings are left out, as proto3 does; a nested message is always written, empty or not (a touch at 0,0 with no pressure is still a touch). */
export function encode(fields: Array<[number, Value]>): Uint8Array {
  const out: number[] = [];
  const varint = (n: number) => {
    let v = Math.max(0, Math.floor(n));
    while (v >= 0x80) {
      out.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    out.push(v);
  };
  for (const [no, v] of fields) {
    if (v === undefined || v === 0 || v === "") continue;
    if (typeof v === "number") {
      varint(no * 8);
      varint(v);
      continue;
    }
    const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
    varint(no * 8 + 2);
    varint(bytes.length);
    for (const b of bytes) out.push(b);
  }
  return Uint8Array.from(out);
}

/** Field number -> the values it carried, in order: a number for a varint, the bytes for a length-delimited field. Fixed-width fields are skipped. */
export function decode(b: Uint8Array): Map<number, Array<number | Uint8Array>> {
  const fields = new Map<number, Array<number | Uint8Array>>();
  let i = 0;
  const varint = () => {
    let n = 0;
    let mul = 1;
    for (;;) {
      if (i >= b.length) throw new Error("A protobuf varint ran past the end of the message.");
      const c = b[i++]!;
      n += (c & 0x7f) * mul;
      if (c < 0x80) return n;
      mul *= 0x80;
    }
  };
  while (i < b.length) {
    const tag = varint();
    const no = Math.floor(tag / 8);
    let v: number | Uint8Array;
    switch (tag % 8) {
      case 0:
        v = varint();
        break;
      case 2: {
        const n = varint();
        v = b.subarray(i, i + n);
        i += n;
        break;
      }
      case 1:
        i += 8;
        continue;
      case 5:
        i += 4;
        continue;
      default:
        throw new Error(`Protobuf wire type ${tag % 8} is not supported.`);
    }
    const list = fields.get(no);
    if (list) list.push(v);
    else fields.set(no, [v]);
  }
  return fields;
}

/* ---- the messages ---- */

/** KeyboardEvent.eventType: a press is the key going down and up. */
const KEYPRESS = 2;
/** KeyboardEvent.codeType for a Linux input code. */
const EVDEV = 1;
/** The top of the touchscreen's ABS_MT_PRESSURE range: a full press. */
const PRESSURE = 1024;

/** W3C key names the emulator maps to Android's keys, or a Linux code where no name reaches the right one (Menu). */
const KEYS: Record<EmulatorKey, string | number> = {
  back: "GoBack",
  home: "GoHome",
  recents: "AppSwitch",
  enter: "Enter",
  delete: "Backspace",
  tab: "Tab",
  escape: "Escape",
  power: "Power",
  volume_up: "AudioVolumeUp",
  volume_down: "AudioVolumeDown",
  menu: 139, // KEY_MENU; "ContextMenu" arrives as KEY_COMPOSE, which Android does not read as Menu
  dpad_up: "ArrowUp",
  dpad_down: "ArrowDown",
  dpad_left: "ArrowLeft",
  dpad_right: "ArrowRight",
};

/** TouchEvent with one finger (identifier 0): pressed at x,y, or lifted there. Panel coordinates in device pixels. */
export const touchMessage = (x: number, y: number, down: boolean): Uint8Array =>
  encode([[1, encode([[1, Math.round(x)], [2, Math.round(y)], [3, 0], [4, down ? PRESSURE : 0]])]]);

export function keyMessage(key: EmulatorKey): Uint8Array {
  const k = KEYS[key];
  if (k === undefined) throw new Error(`Unknown key "${key}".`);
  return typeof k === "number" ? encode([[1, EVDEV], [2, KEYPRESS], [3, k]]) : encode([[2, KEYPRESS], [4, k]]);
}

export const textMessage = (text: string): Uint8Array => encode([[2, KEYPRESS], [5, text]]);

/** A frame of the screenshot stream (an Image: the PNG is field 4), or null for the empty image of a display that is off. */
export function parseImage(m: Uint8Array): Omit<Frame, "mime"> | null {
  const bytes = decode(m).get(4)?.[0];
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  const size = pngSize(bytes);
  return size ? { bytes, ...size } : null;
}

/* ---- gRPC over HTTP/2 ---- */

/** Splits a gRPC body into its messages (each behind a 5-byte prefix: a compression flag and the length), across chunk boundaries, copying a message only when it spans chunks. */
export class MessageReader {
  private chunks: Uint8Array[] = [];
  private size = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    const out: Uint8Array[] = [];
    while (this.size >= 5) {
      const head = this.peek(5);
      if (head[0] !== 0) throw new Error("The emulator sent a compressed gRPC message, which is not supported.");
      const len = head[1]! * 0x1000000 + (head[2]! << 16) + (head[3]! << 8) + head[4]!;
      if (this.size < 5 + len) break;
      out.push(this.take(5 + len).subarray(5));
    }
    return out;
  }

  private peek(n: number): Uint8Array {
    if (this.chunks[0]!.length >= n) return this.chunks[0]!.subarray(0, n);
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of this.chunks) {
      const k = Math.min(c.length, n - o);
      out.set(c.subarray(0, k), o);
      o += k;
      if (o === n) break;
    }
    return out;
  }

  private take(n: number): Uint8Array {
    this.size -= n;
    const first = this.chunks[0]!;
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[0]!;
      const k = Math.min(c.length, n - o);
      out.set(c.subarray(0, k), o);
      o += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    return out;
  }
}

export interface GrpcClient {
  unary(method: string, msg: Uint8Array, timeoutMs?: number): Promise<Uint8Array>;
  /** A server stream: every message to `onMessage` until the returned cancel is called, then `onEnd` once if it ended by itself. */
  stream(method: string, msg: Uint8Array, onMessage: (m: Uint8Array) => void, onEnd: (e: Error | null) => void): () => void;
  close(): void;
}

/** A refused token comes back quoted in the status message: never let it into a log or a toast. */
const redact = (s: string) => s.replace(/Bearer\s+\S+/gi, "Bearer <redacted>");

function statusMessage(raw: unknown): string {
  const s = String(raw ?? "");
  try {
    return redact(decodeURIComponent(s));
  } catch {
    return redact(s);
  }
}

function framed(msg: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + msg.length);
  new DataView(out.buffer).setUint32(1, msg.length);
  out.set(msg, 5);
  return out;
}

export function grpcClient(port: number, token: string, host = "127.0.0.1"): GrpcClient {
  let session: http2.ClientHttp2Session | null = null;
  const connect = () => {
    if (session && !session.closed && !session.destroyed) return session;
    const s = http2.connect(`http://${host}:${port}`);
    s.on("error", () => {}); // each call reports its own failure
    (s as { unref?: () => void }).unref?.();
    session = s;
    return s;
  };

  function open(method: string, msg: Uint8Array, onMessage: (m: Uint8Array) => void, onEnd: (e: Error | null) => void): http2.ClientHttp2Stream {
    const req = connect().request({ ":method": "POST", ":path": SERVICE + method, "content-type": "application/grpc", te: "trailers", authorization: `Bearer ${token}` });
    const reader = new MessageReader();
    let status: number | null = null;
    let message = "";
    let ended = false;
    const end = (e: Error | null) => {
      if (ended) return;
      ended = true;
      onEnd(e);
    };
    // A refusal can come as headers only, with the status in them; otherwise it is in the trailers.
    const take = (h: http2.IncomingHttpHeaders) => {
      if (h["grpc-status"] === undefined) return;
      status = Number(h["grpc-status"]);
      message = statusMessage(h["grpc-message"]);
    };
    req.on("response", take);
    req.on("trailers", take);
    req.on("data", (chunk: Uint8Array) => {
      try {
        for (const m of reader.push(chunk)) onMessage(m);
      } catch (e) {
        req.close(http2.constants.NGHTTP2_CANCEL);
        end(e as Error);
      }
    });
    req.on("error", (e) => end(new GrpcError(-1, redact(e.message))));
    req.on("close", () => end(status === 0 ? null : new GrpcError(status ?? -1, `${method}: ${message || (status === null ? "the emulator closed the call without a status" : `gRPC status ${status}`)}`)));
    req.end(framed(msg));
    return req;
  }

  return {
    unary(method, msg, timeoutMs = CALL_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        let reply: Uint8Array = new Uint8Array();
        const req = open(
          method,
          msg,
          (m) => (reply = m),
          (e) => {
            clearTimeout(timer);
            if (e) reject(e);
            else resolve(reply);
          },
        );
        const timer = setTimeout(() => {
          reject(new GrpcError(4, `${method}: the emulator did not answer within ${timeoutMs} ms`));
          req.close(http2.constants.NGHTTP2_CANCEL);
        }, timeoutMs);
      });
    },
    stream(method, msg, onMessage, onEnd) {
      let on = true;
      const req = open(
        method,
        msg,
        (m) => on && onMessage(m),
        (e) => on && onEnd(e),
      );
      return () => {
        if (!on) return;
        on = false;
        req.close(http2.constants.NGHTTP2_CANCEL);
      };
    },
    close() {
      const s = session;
      session = null;
      s?.destroy();
    },
  };
}

/** The emulator's gRPC endpoint as the owner's LiveChannel. Frames are full-size PNGs of the main display. */
export function grpcChannel(client: GrpcClient): LiveChannel {
  const call = (method: string, msg: Uint8Array) => client.unary(method, msg).then(() => undefined);
  return {
    touch: (x, y, down) => call("sendTouch", touchMessage(x, y, down)),
    key: (key) => call("sendKey", keyMessage(key)),
    text: (text) => call("sendKey", textMessage(text)),
    frames(onFrame, onEnd) {
      return client.stream(
        "streamScreenshot",
        new Uint8Array(), // ImageFormat with every field at its default: PNG, full size, display 0
        (m) => {
          const img = parseImage(m);
          if (img) onFrame({ ...img, mime: "image/png" });
        },
        onEnd,
      );
    },
    close: () => client.close(),
  };
}

/* ---- discovery ---- */

export interface Discovery {
  consolePort: number;
  grpcPort: number | null;
  token: string | null;
}

/** What a discovery file says about one running emulator. */
export function parseDiscovery(text: string): Discovery | null {
  const get = (key: string) => new RegExp(`^${key.replace(/\./g, "\\.")}=(.*)$`, "m").exec(text)?.[1]?.trim() || null;
  const consolePort = Number(get("port.serial"));
  if (!Number.isInteger(consolePort) || consolePort <= 0) return null;
  const grpcPort = Number(get("grpc.port"));
  return { consolePort, grpcPort: Number.isInteger(grpcPort) && grpcPort > 0 ? grpcPort : null, token: get("grpc.token") };
}

/** Where the emulator advertises itself: per OS, as Android Studio reads it, plus the temp folders it inherits from the daemon that started it. */
export function discoveryDirs(env: Record<string, string | undefined> = process.env, platform: string = process.platform, home = os.homedir(), tmp = os.tmpdir()): string[] {
  const roots: Array<string | undefined> = [];
  if (platform === "win32") roots.push(env.TMP, env.TEMP, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Temp"));
  else if (platform === "darwin") roots.push(path.join(home, "Library", "Caches", "TemporaryItems"));
  else roots.push(env.XDG_RUNTIME_DIR, path.join("/tmp", `android-${env.USER || env.LOGNAME || "unknown"}`));
  roots.push(tmp);
  return [...new Set(roots.filter((r): r is string => !!r).map((r) => path.join(r, "avd", "running")))];
}

/** The gRPC endpoints advertised for the emulator on `consolePort`: the file it said it wrote (`hint`) first, then the newest. A crashed emulator leaves its file behind, so the caller tries them in turn. */
export function findEndpoints(consolePort: number, hint: string | null, dirs: string[]): Array<{ port: number; token: string }> {
  const files: Array<{ file: string; mtime: number }> = hint ? [{ file: hint, mtime: Infinity }] : [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^pid_\d+\.ini$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        if (file !== hint) files.push({ file, mtime: fs.statSync(file).mtimeMs });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: Array<{ port: number; token: string }> = [];
  for (const { file } of files) {
    let d: Discovery | null = null;
    try {
      d = parseDiscovery(fs.readFileSync(file, "utf8"));
    } catch {}
    if (d && d.consolePort === consolePort && d.grpcPort && d.token && !out.some((e) => e.port === d!.grpcPort && e.token === d!.token)) out.push({ port: d.grpcPort, token: d.token });
  }
  return out;
}

/** The live channel of the emulator on `consolePort`, or null when it has none (started without -grpc) or none answers. */
export async function openGrpcChannel(consolePort: number, hint: string | null, dirs = discoveryDirs()): Promise<LiveChannel | null> {
  for (const ep of findEndpoints(consolePort, hint, dirs)) {
    const client = grpcClient(ep.port, ep.token);
    try {
      await client.unary("getStatus", new Uint8Array(), STATUS_TIMEOUT_MS);
      return grpcChannel(client);
    } catch {
      client.close();
    }
  }
  return null;
}
