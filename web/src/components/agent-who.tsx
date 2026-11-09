import { useSyncExternalStore } from "react";
import { Field, Select } from "@/components/ui/form";
import { EngineIcon } from "@/components/ui/engine-icon";
import { ModelSelect } from "@/components/ui/model-select";
import { useEngines } from "@/lib/queries";

/** Which engine and model a session starts with. Empty means the server's default_engine. */
export type Who = { engine?: string; model?: string };

export const WHO_KEY = "trb.who";
export const LEGACY_WHO_KEY = "trb.lab.who";

type WhoStore = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): WhoStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parseWho(raw: string | null): Who {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return {};
    return { engine: typeof v.engine === "string" ? v.engine : undefined, model: typeof v.model === "string" ? v.model : undefined };
  } catch {
    return {};
  }
}

/** The shared choice, or the old Lab key on the first read after the key moved. An explicit "{}" is not replaced. */
export function readWho(store: WhoStore | null = defaultStore()): Who {
  try {
    const raw = store?.getItem(WHO_KEY);
    if (raw !== null && raw !== undefined) return parseWho(raw);
  } catch {}
  try {
    return parseWho(store?.getItem(LEGACY_WHO_KEY) ?? null);
  } catch {
    return {};
  }
}

export function writeWho(who: Who, store: WhoStore | null = defaultStore()): void {
  try {
    store?.setItem(WHO_KEY, JSON.stringify({ engine: who.engine, model: who.model }));
  } catch {}
}

let memory: Who | null = null;
const listeners = new Set<() => void>();

/** The choice every mounted picker and button reads. Read once from storage, then held here. */
export function getWho(): Who {
  if (!memory) memory = readWho();
  return memory;
}

export function subscribeWho(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function setWho(who: Who): void {
  memory = { engine: who.engine, model: who.model };
  writeWho(memory);
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // Another tab changed the choice: take its value, or re-read after a clear, and tell every picker.
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== WHO_KEY && e.key !== LEGACY_WHO_KEY) return;
    memory = readWho();
    for (const listener of listeners) listener();
  });
}

/** Which engine and model run a pass, shared by every picker and remembered between visits. */
export function useWho(): [Who, (w: Who) => void] {
  const who = useSyncExternalStore(subscribeWho, getWho, getWho);
  return [who, setWho];
}

/** Which engine and model run a pass. Empty means the default. Remembered between visits. */
export function WhoPicker({ who, onChange, inline = false }: { who: Who; onChange: (w: Who) => void; inline?: boolean }) {
  const engines = useEngines();
  const installed = (engines.data ?? []).filter((e) => e.installed);
  const engine = (
    <Select
      size={inline ? "sm" : "md"}
      aria-label="Engine"
      value={who.engine ?? ""}
      onChange={(id) => onChange({ engine: id || undefined, model: undefined })}
      placeholder="Default"
      options={[{ value: "", label: "Default" }, ...installed.map((e) => ({ value: e.id, label: (<span className="flex items-center gap-1.5"><EngineIcon engine={e.id} className="size-3.5" />{e.label}</span>) }))]}
    />
  );
  const model = <ModelSelect size={inline ? "sm" : "md"} engine={who.engine ?? ""} value={who.model ?? ""} onChange={(id) => onChange({ ...who, model: id || undefined })} disabled={!who.engine} disabledReason="Pick an engine first" />;
  if (inline) {
    return (
      <div className="flex items-center gap-2" data-who-inline>
        <div className="w-36">{engine}</div>
        <div className="w-40">{model}</div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Engine">{engine}</Field>
      <Field label="Model">{model}</Field>
    </div>
  );
}
