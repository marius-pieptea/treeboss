import { useCallback, useState } from "react";

/** `useState` that remembers its value in localStorage (a preference, not data: failures are ignored). */
export function useStored<T extends string | boolean | number>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      return (typeof initial === "string" ? raw : JSON.parse(raw)) as T;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, typeof v === "string" ? v : JSON.stringify(v));
      } catch {}
    },
    [key],
  );
  return [value, set];
}
