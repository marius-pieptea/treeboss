/**
 * The daemon client. One function, typed at the call site; errors carry the server's message so a
 * failed git command shows git's own words in the toast.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: any = null,
  ) {
    super(message);
  }
  /** Extra output from the underlying tool (git's full stderr). */
  get detail(): string | undefined {
    return this.body?.detail;
  }
}

type Listener = () => void;
const signedOutListeners = new Set<Listener>();
/** The UI shows a sign-in screen when any call comes back 401. */
export function onSignedOut(l: Listener): () => void {
  signedOutListeners.add(l);
  return () => signedOutListeners.delete(l);
}

export async function api<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, init: { signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: init.signal,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    if (res.status === 401) for (const l of signedOutListeners) l();
    throw new ApiError(res.status, data?.error ?? `${method} ${path} failed (${res.status})`, data);
  }
  return data as T;
}

export const get = <T = any>(path: string, signal?: AbortSignal) => api<T>("GET", path, undefined, { signal });
export const post = <T = any>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
export const put = <T = any>(path: string, body?: unknown) => api<T>("PUT", path, body ?? {});
export const patch = <T = any>(path: string, body?: unknown) => api<T>("PATCH", path, body ?? {});
export const del = <T = any>(path: string) => api<T>("DELETE", path);

export const qs = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false && v !== "") p.set(k, v === true ? "1" : String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** URL builders, so a path is spelled in one place. */
export const url = {
  fs: (root: string, op: string, params: Record<string, any> = {}) => `/api/fs/${root}/${op}${qs(params)}`,
  git: (root: string, op: string, params: Record<string, any> = {}) => `/api/git/${root}/${op}${qs(params)}`,
  session: (id: string, op = "") => `/api/sessions/${id}${op ? `/${op}` : ""}`,
};
