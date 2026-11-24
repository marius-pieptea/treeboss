/**
 * Traffic recorder for the Rust port's parity replay. Off unless TRB_RECORD_DIR is set; `server.ts` reads the variable once and
 * wraps the fetch handler only then, so an unset daemon runs the original handler untouched.
 *
 * Every `/api/*` request appends one NDJSON line to `<dir>/<first path segment after /api/>.ndjson`. Writes happen after the
 * response exists, on clones, and swallow their own errors: recording can lose a line but never alter or delay a response.
 */
import fs from "fs";
import path from "path";

const CAP = 256 * 1024;
const REQUEST_SECRETS = ["authorization", "cookie"];
const RESPONSE_SECRETS = ["set-cookie"];

export interface Recorded {
  t: number;
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: unknown;
  status: number | null;
  resHeaders: Record<string, string>;
  resBody?: unknown;
  /** SSE or WebSocket: only the request side is recorded. */
  stream?: true;
  /** A body was cut at 256 KB. */
  truncated?: true;
}

const headersOf = (h: Headers, drop: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (!drop.includes(k.toLowerCase())) out[k.toLowerCase()] = v;
  });
  return out;
};

const queryOf = (params: URLSearchParams): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of params) {
    const have = out[k];
    out[k] = have === undefined ? v : Array.isArray(have) ? [...have, v] : [have, v];
  }
  return out;
};

/** At most CAP bytes of a body as text; the rest is dropped without buffering it. */
async function capped(body: ReadableStream<Uint8Array> | null): Promise<{ text: string; cut: boolean }> {
  if (!body) return { text: "", cut: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > CAP) {
      cut = true;
      void reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = Buffer.concat(chunks).subarray(0, CAP);
  return { text: bytes.toString("utf-8"), cut };
}

/** An empty body is null; JSON content parses, anything else (or JSON that does not parse) stays text. */
async function readBody(part: Request | Response): Promise<{ value: unknown; cut: boolean }> {
  const { text, cut } = await capped(part.body);
  if (!text) return { value: null, cut };
  if ((part.headers.get("content-type") ?? "").includes("json")) {
    try {
      return { value: JSON.parse(text), cut };
    } catch {}
  }
  return { value: text, cut };
}

async function write(dir: string, line: Recorded): Promise<void> {
  const segment = line.path.split("/")[2] ?? "";
  const name = segment.replace(/[^A-Za-z0-9_-]/g, "_") || "root";
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.appendFile(path.join(dir, `${name}.ndjson`), `${JSON.stringify(line)}\n`);
}

const isStream = (req: Request, res: Response | undefined): boolean =>
  !res || (res.headers.get("content-type") ?? "").includes("text/event-stream") || req.headers.get("upgrade")?.toLowerCase() === "websocket";

async function record(dir: string, t: number, url: URL, req: Request, reqCopy: Request | null, res: Response | undefined, resCopy: Response | null): Promise<void> {
  const stream = isStream(req, res);
  const line: Recorded = {
    t,
    method: req.method,
    path: url.pathname,
    query: queryOf(url.searchParams),
    headers: headersOf(req.headers, REQUEST_SECRETS),
    body: null,
    status: res?.status ?? null,
    resHeaders: res ? headersOf(res.headers, RESPONSE_SECRETS) : {},
  };
  let cut = false;
  if (reqCopy) {
    const b = await readBody(reqCopy);
    line.body = b.value;
    cut ||= b.cut;
  }
  if (stream) line.stream = true;
  else if (resCopy) {
    const b = await readBody(resCopy);
    line.resBody = b.value;
    cut ||= b.cut;
  }
  if (cut) line.truncated = true;
  await write(dir, line);
}

/**
 * Wrap a fetch handler so each `/api/*` request is recorded into `dir`. Without a directory the handler comes back as it was.
 * A handler that answers a WebSocket upgrade resolves to undefined; that is recorded as a stream.
 */
export function withRecording<A extends unknown[]>(dir: string | undefined, handle: (req: Request, ...rest: A) => Promise<Response>): (req: Request, ...rest: A) => Promise<Response> {
  if (!dir) return handle;
  return async (req, ...rest) => {
    let url: URL | null = null;
    let reqCopy: Request | null = null;
    try {
      url = new URL(req.url);
      if (!url.pathname.startsWith("/api/")) url = null;
      else if (req.body) reqCopy = req.clone();
    } catch {
      url = null;
    }
    const t = Date.now();
    const res = await handle(req, ...rest);
    if (url) {
      const target = url;
      let resCopy: Response | null = null;
      try {
        resCopy = res && !isStream(req, res) ? res.clone() : null;
      } catch {}
      void record(dir, t, target, req, reqCopy, res, resCopy).catch(() => {});
    }
    return res;
  };
}
