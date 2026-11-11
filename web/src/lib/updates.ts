import { useEffect, useState } from "react";
import { toast } from "sonner";
import { shouldNotify, type UpdateState } from "./updates-logic";

interface Bridge {
  version?: string;
  update?: {
    state(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    install(): void;
    openRelease(): void;
    onChange(cb: (s: UpdateState) => void): () => void;
  };
}
const bridge = (): Bridge["update"] | null => (window as unknown as { treebossDesktop?: Bridge }).treebossDesktop?.update ?? null;

/** True in the desktop app: a plain browser has no updater. */
export const hasUpdater = () => bridge() !== null;

let current: UpdateState | null = null;
const listeners = new Set<(s: UpdateState | null) => void>();
let started = false;

function apply(next: UpdateState) {
  const notify = shouldNotify(current, next);
  current = next;
  listeners.forEach((l) => l(next));
  if (!notify) return;
  if (next.status === "ready") toast.success(`TreeBoss ${next.latest} is ready`, { description: "Restart to finish updating.", duration: 15000, action: { label: "Restart now", onClick: () => bridge()?.install() } });
  else toast(`TreeBoss ${next.latest} is available`, { description: "This build updates by hand.", duration: 15000, action: { label: "Download", onClick: () => bridge()?.openRelease() } });
}

/** Subscribes once to the shell's update state; safe to call from several components. */
function start() {
  const b = bridge();
  if (started || !b) return;
  started = true;
  b.onChange(apply);
  void b.state().then(apply).catch(() => {});
}

export function useUpdate() {
  const [state, setState] = useState<UpdateState | null>(current);
  useEffect(() => {
    start();
    listeners.add(setState);
    setState(current);
    return () => void listeners.delete(setState);
  }, []);
  return {
    state,
    check: () => void bridge()?.check().then(apply),
    install: () => bridge()?.install(),
    openRelease: () => bridge()?.openRelease(),
  };
}
