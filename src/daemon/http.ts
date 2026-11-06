import { timingSafeEqual } from "crypto";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function bodyOf(req: Request): Promise<Record<string, any>> {
  if (req.method === "GET" || req.method === "DELETE" || req.method === "HEAD") return {};
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
}

/** What a route module sees once a request is authenticated. */
export interface Ctx {
  req: Request;
  url: URL;
  method: string;
  path: string;
  body: Record<string, any>;
  /** Who is calling: the owner (token or cookie) or a paired remote device. Set by the server before dispatch. */
  principal?: { kind: "owner"; via: "bearer" | "cookie" } | { kind: "remote"; id: string; label: string };
  /** Match `path` against a pattern; the groups are the path parameters. */
  match(re: RegExp): RegExpMatchArray | null;
  q(name: string): string | null;
}

/** A route module: returns a Response when it owns the request, null when it does not. */
export type RouteModule = (c: Ctx) => Promise<Response | null> | Response | null;

export function makeCtx(req: Request, url: URL, body: Record<string, any>): Ctx {
  return {
    req,
    url,
    method: req.method,
    path: url.pathname,
    body,
    match: (re) => url.pathname.match(re),
    q: (name) => url.searchParams.get(name),
  };
}
