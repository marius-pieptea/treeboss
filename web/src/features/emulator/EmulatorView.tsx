import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Bot, Circle, Hand, Home, Play, Power, PowerOff, RotateCw, Smartphone, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { Badge, Empty, Spinner } from "@/components/ui/misc";
import { placePicture } from "../browser/agent-logic";
import { runExpoOnEmulator, useEmulator, type EmulatorState, type InstallPlan } from "./emulator-api";
import { actorLabel, classifyGesture, formatBytes, keyFromEvent, progressOf, rotateTarget, screenOf, stepLabel, toDevicePoint } from "./emulator-logic";

type Emu = ReturnType<typeof useEmulator>;
type Point = { x: number; y: number };

/**
 * The Android emulator, live. The daemon owns one device; this view installs it (after the operator accepts Google's
 * license: only here, never an agent), shows its screen, and sends the operator's taps, swipes and keys to it.
 */
export function EmulatorView() {
  const emu = useEmulator();
  const { state } = emu;

  let body: React.ReactNode;
  if (emu.loading) body = <Centered><Spinner className="size-5" /></Centered>;
  else if (!state) body = <Empty icon={<AlertTriangle />} title="Could not read the emulator" hint={emu.error ?? "The daemon did not answer."} className="[&_svg]:text-amber" />;
  else if (!state.enabled) body = <Empty icon={<Power />} title="The emulator is turned off" hint="Turn it on with `trb config set emulator on`, or in Settings." />;
  else body = <Screen state={state} emu={emu} />;

  return <div className="flex h-full min-w-0 flex-col bg-bg">{body}</div>;
}

const Centered = ({ children }: { children: React.ReactNode }) => <div className="flex h-full items-center justify-center">{children}</div>;

/** One branch per screen: the SDK's state, then the device's. */
function Screen({ state, emu }: { state: EmulatorState; emu: Emu }) {
  const { sdk, device } = state;
  switch (screenOf(state)) {
    case "absent":
      return <Absent state={state} emu={emu} />;
    case "resolving":
      return <Empty icon={<Spinner className="size-5" />} title="Looking up Google's packages" hint="Reading the package lists to plan the install." />;
    case "needs-license":
      return sdk.kind === "needs-license" ? <NeedsLicense plan={sdk.plan} emu={emu} /> : null;
    case "installing":
      return sdk.kind === "installing" ? <Installing sdk={sdk} emu={emu} /> : null;
    case "removing":
      return <Empty icon={<Spinner className="size-5" />} title="Removing the emulator" hint="Stopping the device and deleting the SDK and virtual device treeboss installed." />;
    case "sdk-failed":
      return sdk.kind === "failed" ? (
        <Empty
          icon={<AlertTriangle />}
          title="The install failed"
          hint={sdk.reason}
          className="[&_svg]:text-red"
          action={sdk.retryable ? <Button variant="primary" onClick={() => void emu.retry()}>Retry</Button> : <Button variant="outline" onClick={() => void emu.install()}>Start over</Button>}
        />
      ) : null;
    case "stopped":
      return <Stopped state={state} emu={emu} />;
    case "booting":
      return <Empty icon={<Spinner className="size-5" />} title="Starting the emulator" hint="The first boot takes a minute or two." />;
    case "stopping":
      return <Empty icon={<Spinner className="size-5" />} title="Shutting the emulator down" />;
    case "device-failed":
      return device.kind === "failed" ? (
        <Failed
          reason={device.reason}
          logTail={device.logTail}
          action={
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={() => void emu.boot()}>
                <Play /> Restart
              </Button>
              <RemoveEmulator state={state} emu={emu} />
            </div>
          }
        />
      ) : null;
    case "running":
      return <Running state={state} emu={emu} />;
  }
}

/* ---- install ---------------------------------------------------------------------------------------- */

function Absent({ state, emu }: { state: EmulatorState; emu: Emu }) {
  const { host } = state;
  const noDisk = host.diskFreeBytes < host.needBytes;
  return (
    <Empty
      icon={<Smartphone />}
      title="Run your React Native app on an Android emulator"
      hint={`treeboss installs Google's Android emulator for you, shows it here, and lets agents drive it. It needs about ${formatBytes(host.needBytes)} of disk.`}
      action={
        <div className="flex w-full max-w-md flex-col items-center gap-3">
          {host.accel.state === "missing" && (
            <Warning title={host.accel.reason}>{host.accel.fix}</Warning>
          )}
          {noDisk && (
            <Warning title="Not enough disk space">
              {formatBytes(host.diskFreeBytes)} free, {formatBytes(host.needBytes)} needed.
            </Warning>
          )}
          {host.existingSdk && <p className="text-xs text-fg-muted">An Android SDK was found at <span className="font-mono">{host.existingSdk}</span>. It is only read, never changed.</p>}
          <Button variant="primary" className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-center" disabled={noDisk} onClick={() => void emu.install()}>
            Install the Android emulator
          </Button>
        </div>
      }
    />
  );
}

function Warning({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="alert" className="flex w-full items-start gap-2 rounded-lg border border-amber/30 bg-amber/10 p-3 text-left text-xs">
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium text-fg">{title}</span>
        <span className="text-fg-muted">{children}</span>
      </div>
    </div>
  );
}

function NeedsLicense({ plan, emu }: { plan: InstallPlan; emu: Emu }) {
  const total = plan.packages.reduce((n, p) => n + p.size, 0);
  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-3 overflow-auto p-4">
      <h2 className="text-sm font-semibold text-fg">Accept Google's license to install the emulator</h2>
      <p className="text-xs text-fg-muted">Google's license does not allow redistributing the Android SDK, so treeboss downloads it from Google. Only you can accept it; agents cannot.</p>
      <ul className="flex flex-col gap-1">
        {plan.packages.map((p) => (
          <li key={p.path} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-line bg-raised px-3 py-1.5 text-xs">
            <span className="min-w-0 flex-1 basis-40 break-all font-mono text-fg">{p.path}</span>
            <span className="font-mono text-fg-muted">{formatBytes(p.size)}</span>
          </li>
        ))}
        <li className="flex flex-wrap justify-end gap-x-1.5 px-3 text-xs text-fg-muted">
          Total download <span className="whitespace-nowrap font-mono text-fg">{formatBytes(total)}</span>
        </li>
      </ul>
      {plan.licenses.map((l) => (
        <section key={l.id} className="flex flex-col gap-1">
          <h3 className="font-mono text-xs text-fg-muted">{l.id}</h3>
          <pre tabIndex={0} aria-label={`License text: ${l.id}`} className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-raised p-3 font-mono text-xs text-fg">
            {l.text}
          </pre>
        </section>
      ))}
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void emu.accept(plan.licenses.map((l) => l.id))}>
          Accept and install
        </Button>
        <Button variant="outline" onClick={() => void emu.cancel()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Installing({ sdk, emu }: { sdk: Extract<EmulatorState["sdk"], { kind: "installing" }>; emu: Emu }) {
  const pct = Math.round(progressOf(sdk.doneBytes, sdk.totalBytes) * 100);
  return (
    <Empty
      icon={<Spinner className="size-5" />}
      title={stepLabel(sdk.step)}
      action={
        <div className="flex w-full max-w-sm flex-col items-center gap-3">
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono text-xs text-fg-muted">
            {formatBytes(sdk.doneBytes)} of {formatBytes(sdk.totalBytes)} · {pct}%
          </span>
          <Button variant="outline" onClick={() => void emu.cancel()}>
            Cancel
          </Button>
        </div>
      }
    />
  );
}

/* ---- device ----------------------------------------------------------------------------------------- */

function Stopped({ state, emu }: { state: EmulatorState; emu: Emu }) {
  return (
    <Empty
      icon={<Smartphone />}
      title="The emulator is not running"
      hint={state.host.accel.state === "missing" ? undefined : "Start it to watch and drive the phone."}
      action={
        <div className="flex w-full max-w-md flex-col items-center gap-3">
          {state.host.accel.state === "missing" && <Warning title={state.host.accel.reason}>{state.host.accel.fix}</Warning>}
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void emu.boot()}>
              <Play /> Start
            </Button>
            <RemoveEmulator state={state} emu={emu} />
          </div>
        </div>
      }
    />
  );
}

function Failed({ reason, logTail, action }: { reason: string; logTail: string; action: React.ReactNode }) {
  return (
    <Empty
      icon={<AlertTriangle />}
      title="The emulator stopped working"
      hint={reason}
      className="[&_svg]:text-red"
      action={
        <div className="flex w-full max-w-xl flex-col items-center gap-3">
          {logTail && <pre aria-label="Emulator log" className="max-h-60 w-full overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-raised p-3 text-left font-mono text-xs text-fg-muted">{logTail}</pre>}
          {action}
        </div>
      }
    />
  );
}

/** Only an install treeboss made can be removed: an SDK found on the machine is never touched. */
function RemoveEmulator({ state, emu }: { state: EmulatorState; emu: Emu }) {
  const [open, setOpen] = useState(false);
  if (state.sdk.kind !== "installed" || !state.sdk.owned) return null;
  return (
    <>
      <Button variant="dangerGhost" onClick={() => setOpen(true)}>
        <Trash2 /> Remove emulator
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Remove the emulator?"
        description="Stops the device and deletes the Android SDK and virtual device treeboss installed, including the apps and data on the phone. You can install it again later."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setOpen(false);
                void emu.remove();
              }}
            >
              Remove
            </Button>
          </>
        }
      />
    </>
  );
}

function Running({ state, emu }: { state: EmulatorState; emu: Emu }) {
  const { workspace } = useWorkspace();
  const { frame, send } = emu;
  const screen = state.device.kind === "running" ? state.device.screen : { width: 720, height: 1600 };
  // Over the emulator's gRPC channel the finger and the keys go as they happen; over adb a gesture is sent once it ends.
  const live = state.device.kind === "running" && state.device.live;
  const rotated = state.device.kind === "running" && state.device.rotation !== 0;

  // The picture's box is measured through a callback ref, as the agent browser's is: it only exists once the device runs.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const setBoxNode = useCallback((n: HTMLDivElement | null) => {
    boxRef.current = n;
    setBoxEl(n);
  }, []);
  useEffect(() => {
    if (!boxEl) return;
    const ro = new ResizeObserver(([e]) => setBox({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(boxEl);
    return () => ro.disconnect();
  }, [boxEl]);
  const placed = useMemo(() => placePicture(box, screen), [box, screen]);
  const [focused, setFocused] = useState(false);

  /* ---- take-over: pointer and keyboard ----------------------------------------------------------------- */

  const pointerToDevice = (e: { clientX: number; clientY: number }): Point | null => {
    const r = boxRef.current?.getBoundingClientRect();
    return r ? toDevicePoint({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, screen) : null;
  };

  // A press is remembered until its release, with the last point the pointer was seen on the phone: ending a swipe on the margin still ends it.
  // It keeps the channel it started on, so a press that began live ends live.
  const press = useRef<{ at: number; from: Point; last: Point; live: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    boxRef.current?.focus();
    const p = pointerToDevice(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { at: performance.now(), from: p, last: p, live };
    if (live) emu.live({ kind: "pointer", phase: "down", ...p });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointerToDevice(e);
    const down = press.current;
    if (!down || !p || (p.x === down.last.x && p.y === down.last.y)) return;
    down.last = p;
    if (down.live) emu.live({ kind: "pointer", phase: "move", ...p });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const down = press.current;
    press.current = null;
    if (!down) return;
    const end = pointerToDevice(e) ?? down.last;
    if (down.live) emu.live({ kind: "pointer", phase: "up", ...end });
    else void send(classifyGesture(down.from, end, performance.now() - down.at));
  };
  // The browser took the pointer away: lift a live finger, send no gesture.
  const onPointerCancel = () => {
    const down = press.current;
    press.current = null;
    if (down?.live) emu.live({ kind: "pointer", phase: "up", ...down.last });
  };

  // Typed characters are batched: one request per burst, in order.
  const typing = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({ text: "", timer: null });
  const flushTyping = useCallback(() => {
    const t = typing.current;
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    if (t.text) {
      const text = t.text;
      t.text = "";
      void send({ kind: "text", text });
    }
  }, [send]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const a = keyFromEvent(e);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    if (live) {
      emu.live({ kind: "input", input: a });
      return;
    }
    if (a.kind === "text") {
      typing.current.text += a.text;
      if (!typing.current.timer) typing.current.timer = setTimeout(flushTyping, 60);
    } else {
      flushTyping();
      void send({ kind: "key", key: a.key });
    }
  };

  /* ---- render ----------------------------------------------------------------------------------------- */

  const last = state.lastActor;
  const expo = state.metro;
  const expoBusy = expo.kind === "starting" || expo.kind === "running";

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        <IconButton label="Back" size="icon-sm" onClick={() => void send({ kind: "key", key: "back" })}>
          <ArrowLeft />
        </IconButton>
        <IconButton label="Home" size="icon-sm" onClick={() => void send({ kind: "key", key: "home" })}>
          <Home />
        </IconButton>
        <IconButton label="Recent apps" size="icon-sm" onClick={() => void send({ kind: "key", key: "recents" })}>
          <Square />
        </IconButton>
        <IconButton label={`Rotate to ${rotateTarget(screen)}`} size="icon-sm" onClick={() => void send({ kind: "rotate", to: rotateTarget(screen) })}>
          <RotateCw />
        </IconButton>
        <IconButton label="Power button" size="icon-sm" onClick={() => void send({ kind: "key", key: "power" })}>
          <Power />
        </IconButton>
        <IconButton label="Shut the emulator down" size="icon-sm" onClick={() => void emu.shutdown()}>
          <PowerOff />
        </IconButton>
        <div className="ml-auto flex items-center gap-2">
          <MetroStatus state={state} />
          {expoBusy ? (
            <Button size="sm" variant="outline" onClick={() => void emu.stopExpo()}>
              Stop Expo
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                runExpoOnEmulator(workspace.id)
                  .then((r) => !r.ok && toast.error(r.error))
                  .catch((e: Error) => toast.error(e.message))
              }
            >
              Run Expo
            </Button>
          )}
          <RemoveEmulator state={state} emu={emu} />
        </div>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-bg px-3 text-xs">
        {last ? (
          <>
            <Badge tone={last.actor.kind === "you" ? "neutral" : "accent"}>
              {last.actor.kind === "you" ? <Hand className="size-2.5" /> : <Bot className="size-2.5" />}
              {actorLabel(last.actor)}
            </Badge>
            <span className="text-fg-muted">last touched it at {new Date(last.at).toLocaleTimeString()}</span>
          </>
        ) : (
          <span className="text-fg-muted">Nobody has touched it yet</span>
        )}
        <span
          className="ml-auto font-mono text-fg-muted"
          title={live ? "Touches and keys go straight to the emulator over its gRPC channel." : rotated ? "Rotated: input goes through adb, a gesture at a time." : "Input goes through adb, a gesture at a time. Shut the emulator down and start it again from here for live touch."}
        >
          {live ? "live" : "adb"} · {screen.width}×{screen.height}
        </span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-bg">
        <div
          ref={setBoxNode}
          tabIndex={0}
          role="application"
          aria-label="Android emulator. Click the screen, then type to take over."
          onFocus={() => setFocused(true)}
          onBlur={() => {
            flushTyping();
            setFocused(false);
          }}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          className={cn("relative size-full cursor-default touch-none select-none outline-none", focused && "ring-1 ring-inset ring-accent/40")}
        >
          {frame ? (
            <img src={frame.url} alt="Android emulator screen" draggable={false} className="pointer-events-none absolute select-none rounded-xl border border-line-strong bg-bg" style={{ left: placed.x, top: placed.y, width: placed.width, height: placed.height }} />
          ) : (
            <Centered>
              <Spinner className="size-5" />
            </Centered>
          )}
          {!focused && frame && <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-line bg-overlay/90 px-3 py-1 text-xs text-fg-muted shadow-pop animate-slide-up">Click the screen to take over</div>}
        </div>
      </div>
      {expo.kind === "failed" && (
        <div className="shrink-0 border-t border-line bg-panel p-3">
          <Warning title={`Expo stopped: ${expo.reason}`}>
            <span className="whitespace-pre-wrap font-mono">{expo.logTail}</span>
          </Warning>
        </div>
      )}
    </>
  );
}

function MetroStatus({ state }: { state: EmulatorState }) {
  const m = state.metro;
  if (m.kind === "off") return <span className="text-xs text-fg-muted">Expo is off</span>;
  if (m.kind === "starting") return <Badge tone="amber"><Spinner className="size-2.5" /> Expo starting</Badge>;
  if (m.kind === "running") return <Badge tone="green"><Circle className="size-2 fill-current" /> Metro :{m.port}</Badge>;
  return <Badge tone="red">Expo failed</Badge>;
}
