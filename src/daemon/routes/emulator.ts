/**
 * Android emulator API: the Emulator tab's data and the operator's controls. There is one device per daemon.
 *
 *   GET  /api/emulator/state                 the EmulatorView (reads the disk and probes the host the first time)
 *   POST /api/emulator/install   { op }      plan | cancel | retry                      -> EmulatorView
 *   POST /api/emulator/license   { accept }  the license ids the operator accepted      -> EmulatorView
 *   POST /api/emulator/remove                delete the treeboss-owned SDK and device    -> EmulatorView (409 unless installed and owned)
 *   POST /api/emulator/boot, /shutdown       boot or stop the device                     -> CommandResult
 *   POST /api/emulator/input     { kind, … } a tap, swipe, text, key or rotate           -> CommandResult
 *   POST /api/emulator/pointer   { x, y, down } the finger on the live view (`device.live`) -> CommandResult
 *   GET  /api/emulator/screenshot?seq=N      the current frame as a PNG
 *   GET  /api/emulator/stream                SSE: a `state` event whenever the picture or the status changed
 *   POST /api/emulator/run-expo  { workspaceId }, /stop-expo
 *   GET  /api/emulator/logs?tag=&lines=
 *
 * Accepting a license, removing the emulator and shutting it down are the operator's: only these routes construct
 * the `by: "you"` operations and the `you` actor. A remote device gets none of it.
 */
import { EmulatorError, emulator } from "../../emulator/emulator";
import { EMULATOR_KEYS, type EmulatorInput, type EmulatorView } from "../../emulator/types";
import { RootError, resolveRoot } from "../../workspaces";
import { HttpError, json, type Ctx, type RouteModule } from "../http";

const YOU = { kind: "you" } as const;
const INPUT_KINDS = new Set(["tap", "long_press", "swipe", "text", "key", "rotate"]);
/** At most one `state` event this often: frames and install progress come in bursts. */
const STATE_GAP_MS = 33;

/**
 * Follow the device: a `state` event with the EmulatorView whenever anything changed. A change after a quiet spell
 * goes out at once (a new frame is fetched as soon as it exists); a burst is folded to one event per STATE_GAP_MS.
 * Shared by the SSE endpoint and the multiplexed live socket. Following counts as watching, so the frames keep
 * coming and the idle shutdown holds off while someone is looking.
 */
export function followEmulator(emit: (event: string, data: unknown) => void): () => void {
  const emu = emulator();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const unwatch = emu.watch(() => {
    if (stopped || timer) return;
    timer = setTimeout(
      () => {
        timer = null;
        last = Date.now();
        if (!stopped) emit("state", emu.snapshot());
      },
      Math.max(0, last + STATE_GAP_MS - Date.now()),
    );
  });
  void emu.refresh().then((v) => !stopped && emit("state", v)).catch(() => {});
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unwatch();
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Parse the body of POST /input into an EmulatorInput, or say what is wrong. */
function parseInput(b: Record<string, any>): EmulatorInput {
  if (!INPUT_KINDS.has(b.kind)) throw new HttpError(400, `kind must be one of ${[...INPUT_KINDS].join(", ")}.`);
  const num = (k: string) => {
    if (typeof b[k] !== "number" || !Number.isFinite(b[k])) throw new HttpError(400, `${k} must be a number.`);
    return b[k] as number;
  };
  const optMs = typeof b.ms === "number" ? b.ms : undefined;
  switch (b.kind) {
    case "tap":
      return { kind: "tap", x: num("x"), y: num("y") };
    case "long_press":
      return { kind: "long_press", x: num("x"), y: num("y"), ms: optMs };
    case "swipe":
      return { kind: "swipe", x1: num("x1"), y1: num("y1"), x2: num("x2"), y2: num("y2"), ms: optMs };
    case "text":
      if (typeof b.text !== "string") throw new HttpError(400, "text must be a string.");
      return { kind: "text", text: b.text };
    case "key":
      if (!(EMULATOR_KEYS as readonly string[]).includes(b.key)) throw new HttpError(400, `key must be one of ${EMULATOR_KEYS.join(", ")}.`);
      return { kind: "key", key: b.key };
    default:
      if (b.to !== "portrait" && b.to !== "landscape") throw new HttpError(400, "to must be portrait or landscape.");
      return { kind: "rotate", to: b.to };
  }
}

/** An install operation that does not fit the state (or is not allowed) is a 409 with the owner's reason. */
async function installOp(op: Parameters<ReturnType<typeof emulator>["install"]>[0]): Promise<EmulatorView> {
  const emu = emulator();
  try {
    await emu.refresh();
    await emu.install(op);
  } catch (e) {
    if (e instanceof EmulatorError) throw new HttpError(409, e.message);
    throw e;
  }
  return emu.snapshot();
}

export const emulatorRoutes: RouteModule = async (c: Ctx) => {
  if (!c.path.startsWith("/api/emulator/")) return null;
  const op = c.path.slice("/api/emulator/".length);
  if (c.principal?.kind === "remote") throw new HttpError(403, "The Android emulator is not available to a remote device.");
  const emu = emulator();

  if (op === "state" && c.method === "GET") return json(await emu.refresh());

  if (op === "install" && c.method === "POST") {
    const kind = str(c.body.op);
    if (kind !== "plan" && kind !== "cancel" && kind !== "retry") throw new HttpError(400, "op must be plan, cancel or retry.");
    return json(await installOp({ kind }));
  }

  if (op === "license" && c.method === "POST") {
    if (!Array.isArray(c.body.accept) || !c.body.accept.every((x: unknown) => typeof x === "string")) throw new HttpError(400, "accept must be a list of license ids.");
    return json(await installOp({ kind: "accept", by: "you", licenses: c.body.accept }));
  }

  if (op === "remove" && c.method === "POST") {
    const v = await emu.refresh();
    if (v.sdk.kind !== "installed") throw new HttpError(409, "The emulator is not installed.");
    if (!v.sdk.owned) throw new HttpError(409, "This SDK was found on this machine, not installed by treeboss, so treeboss will not remove it.");
    return json(await installOp({ kind: "remove", by: "you" }));
  }

  if (op === "boot" && c.method === "POST") {
    await emu.refresh();
    return json(await emu.run(YOU, { kind: "boot" }));
  }
  if (op === "shutdown" && c.method === "POST") return json(await emu.run(YOU, { kind: "shutdown" }));

  if (op === "input" && c.method === "POST") return json(await emu.run(YOU, { kind: "input", input: parseInput(c.body) }));

  if (op === "pointer" && c.method === "POST") {
    const { x, y, down } = c.body;
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) throw new HttpError(400, "x and y must be numbers.");
    if (typeof down !== "boolean") throw new HttpError(400, "down must be true or false.");
    return json(await emu.pointer(YOU, { x, y, down }));
  }

  if (op === "screenshot" && c.method === "GET") {
    let frame = emu.frame();
    if (!frame) {
      const shot = await emu.capture(YOU);
      if (!shot.ok) throw new HttpError(404, shot.error);
      frame = shot.frame;
    }
    return new Response(new Uint8Array(frame.bytes), { headers: { "content-type": "image/png", "cache-control": "no-store", "x-frame-seq": String(frame.seq) } });
  }

  if (op === "stream" && c.method === "GET") {
    const enc = new TextEncoder();
    let stop: (() => void) | null = null;
    let beat: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        const emit = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };
        stop = followEmulator(emit);
        beat = setInterval(() => emit("ping", { t: Date.now() }), 15_000);
        c.req.signal.addEventListener("abort", () => {
          closed = true;
          stop?.();
          if (beat) clearInterval(beat);
        });
      },
      cancel() {
        stop?.();
        if (beat) clearInterval(beat);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

  if (op === "run-expo" && c.method === "POST") {
    const ref = str(c.body.workspaceId);
    if (!ref) throw new HttpError(400, "workspaceId is required.");
    let dir: string;
    try {
      dir = resolveRoot(ref).dir;
    } catch (e) {
      if (e instanceof RootError) throw new HttpError(e.status, e.message);
      throw e;
    }
    await emu.refresh();
    return json(await emu.run(YOU, { kind: "run_expo", cwd: dir }));
  }
  if (op === "stop-expo" && c.method === "POST") return json(await emu.run(YOU, { kind: "stop_expo" }));

  if (op === "logs" && c.method === "GET") {
    const lines = Math.min(Math.max(Number(c.q("lines")) || 100, 1), 500);
    return json(await emu.logs(YOU, c.q("tag") || "ReactNativeJS", lines));
  }

  return null;
};
