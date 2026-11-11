import { useSyncExternalStore } from "react";
import { getWho, subscribeWho, type Who } from "@/components/agent-who";
import type { Driver } from "./api";

export const DRIVER_KEY = "trb.qa.driver";

type Store = Pick<Storage, "getItem" | "setItem">;

const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** A stored driver, or null when it is missing or not one of the two shapes. */
export function parseDriver(raw: string | null): Driver | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    if (v.kind === "pair") return typeof v.pairId === "string" && v.pairId ? { kind: "pair", pairId: v.pairId } : null;
    if (v.kind !== "agent") return null;
    const d: Extract<Driver, { kind: "agent" }> = { kind: "agent" };
    for (const k of ["engine", "model", "effort", "agent"] as const) if (typeof v[k] === "string" && v[k]) d[k] = v[k];
    return d;
  } catch {
    return null;
  }
}

/** The agent the shared engine and model choice stands for. */
export const agentFromWho = (who: Who): Driver => ({ kind: "agent", ...(who.engine ? { engine: who.engine } : {}), ...(who.model ? { model: who.model } : {}) });

export function readDriver(who: Who, store: Store | null = defaultStore()): Driver {
  try {
    return parseDriver(store?.getItem(DRIVER_KEY) ?? null) ?? agentFromWho(who);
  } catch {
    return agentFromWho(who);
  }
}

let chosen: Driver | null | undefined;
let derived: { who: Who; driver: Driver } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function snapshot(): Driver {
  if (chosen === undefined) {
    try {
      chosen = parseDriver(defaultStore()?.getItem(DRIVER_KEY) ?? null);
    } catch {
      chosen = null;
    }
  }
  if (chosen) return chosen;
  const who = getWho();
  if (!derived || derived.who !== who) derived = { who, driver: agentFromWho(who) };
  return derived.driver;
}

function choose(d: Driver): void {
  chosen = d;
  try {
    defaultStore()?.setItem(DRIVER_KEY, JSON.stringify(d));
  } catch {}
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const off = subscribeWho(l);
  return () => {
    listeners.delete(l);
    off();
  };
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== DRIVER_KEY) return;
    chosen = undefined;
    emit();
  });
}

/** Who runs the QA jobs: remembered between visits; an agent on the shared engine and model until one is chosen. */
export function useQaDriver(): [Driver, (d: Driver) => void] {
  return [useSyncExternalStore(subscribe, snapshot, snapshot), choose];
}
