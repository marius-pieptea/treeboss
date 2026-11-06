import { useCallback, useEffect, useRef, useState } from "react";

/** Keyboard shortcut. `mod` is Cmd on macOS and Ctrl elsewhere. Returns nothing; unregisters on unmount. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export interface Combo {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export function matchCombo(e: KeyboardEvent, c: Combo): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!!c.mod !== mod) return false;
  if (!!c.shift !== e.shiftKey) return false;
  if (!!c.alt !== e.altKey) return false;
  return e.key.toLowerCase() === c.key.toLowerCase();
}

export function useHotkey(combo: Combo, handler: (e: KeyboardEvent) => void, opts: { allowInInput?: boolean; enabled?: boolean } = {}): void {
  const ref = useRef(handler);
  ref.current = handler;
  const { key, mod, shift, alt } = combo;
  useEffect(() => {
    if (opts.enabled === false) return;
    const on = (e: KeyboardEvent) => {
      if (!matchCombo(e, { key, mod, shift, alt })) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // Shortcuts with a modifier work everywhere (Cmd-S in the editor); bare keys never fire while typing.
      if (typing && !mod && !opts.allowInInput) return;
      e.preventDefault();
      ref.current(e);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [key, mod, shift, alt, opts.allowInInput, opts.enabled]);
}

export function formatCombo(c: Combo): string {
  const k = c.key.length === 1 ? c.key.toUpperCase() : c.key;
  return [c.mod ? (isMac ? "⌘" : "Ctrl+") : "", c.shift ? (isMac ? "⇧" : "Shift+") : "", c.alt ? (isMac ? "⌥" : "Alt+") : "", k].join("");
}

export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Pointer-follow glow for `.glow-surface`: sets --mx/--my on the element. */
export function useGlow() {
  return {
    onPointerMove: useCallback((e: React.PointerEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
      e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
    }, []),
    onPointerLeave: useCallback((e: React.PointerEvent<HTMLElement>) => {
      e.currentTarget.style.removeProperty("--mx");
      e.currentTarget.style.removeProperty("--my");
    }, []),
  };
}

/** Drag-to-resize. `axis` x: dragging right grows (left pane); `invert` flips it (right pane, bottom pane grows upward). */
export function useDragResize(opts: { axis: "x" | "y"; invert?: boolean; value: number; min: number; max: number; onChange: (px: number) => void; onEnd?: () => void }) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const o = useRef(opts);
  o.current = opts;
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { pos: opts.axis === "x" ? e.clientX : e.clientY, value: opts.value };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const cur = o.current.axis === "x" ? e.clientX : e.clientY;
    const delta = (cur - start.current.pos) * (o.current.invert ? -1 : 1);
    o.current.onChange(Math.min(o.current.max, Math.max(o.current.min, start.current.value + delta)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    o.current.onEnd?.();
  };
  return { dragging, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}
