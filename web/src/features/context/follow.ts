import { useSyncExternalStore } from "react";

/** "Always attach what is in view": one remembered preference, shared by the composer and the session menu. */
const KEY = "trb.context.followView";
const listeners = new Set<() => void>();

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
let value = read();

export function setFollowView(on: boolean): void {
  value = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private window: the choice lasts until reload */
  }
  listeners.forEach((l) => l());
}

export function useFollowView(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => value,
  );
}
