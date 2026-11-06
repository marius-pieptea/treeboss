/** Is the daemon answering? A reload banner and automatic recovery when it comes back (it may have restarted). */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** Misses in a row before the daemon counts as gone: one slow answer while it is busy is not an outage. */
const MISSES_OFFLINE = 2;

export function useDaemonOnline(intervalMs = 4000): boolean {
  const [online, setOnline] = useState(true);
  const was = useRef(true);
  const misses = useRef(0);
  const qc = useQueryClient();
  useEffect(() => {
    let stop = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      let ok = false;
      try {
        ok = (await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(5000) })).ok;
      } catch {}
      busy = false;
      if (stop) return;
      misses.current = ok ? 0 : misses.current + 1;
      const up = ok || (was.current && misses.current < MISSES_OFFLINE);
      if (up && !was.current) {
        // Back (possibly a new process): streams reconnect from their stored cursor, queries refetch.
        window.dispatchEvent(new Event("trb:reload-streams"));
        void qc.invalidateQueries();
      }
      was.current = up;
      setOnline(up);
    };
    const t = setInterval(tick, intervalMs);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [intervalMs, qc]);
  return online;
}
