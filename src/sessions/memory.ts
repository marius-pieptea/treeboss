/**
 * Available memory, for the guard that refuses new turns when the machine is short of it (min_free_memory_mb).
 *
 * On Linux `os.freemem()` is MemFree, which leaves out the page cache the kernel would give back at once, so the
 * kernel's own estimate (MemAvailable) is read instead. On macOS `os.freemem()` is only the truly free pages, which the
 * kernel keeps low on purpose (a 48 GB machine with no memory pressure shows under 1 GB), so the pages it would hand back
 * at once are added from `vm_stat`: inactive, speculative and purgeable. Elsewhere `os.freemem()` is the best there is.
 * The reader is swappable so the guard can be tested with any number on any platform.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";

export type MemoryReader = () => number;

/** Megabytes macOS can give a new turn, from `vm_stat` output: free + inactive + speculative + purgeable pages. Null when unreadable. */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!pageSize) return null;
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? NaN);
  const counts = ["free", "inactive", "speculative", "purgeable"].map(pages);
  if (counts.some((n) => !Number.isFinite(n))) return null;
  return (counts.reduce((a, b) => a + b, 0) * pageSize) / (1024 * 1024);
}

/** Megabytes a new turn can count on. */
export function readAvailableMb(): number {
  if (process.platform === "linux") {
    try {
      const m = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (m) return Number(m[1]) / 1024;
    } catch {}
  }
  if (process.platform === "darwin") {
    try {
      const mb = parseVmStat(execFileSync("/usr/bin/vm_stat", { encoding: "utf8", timeout: 2000 }));
      if (mb !== null) return mb;
    } catch {}
  }
  return os.freemem() / (1024 * 1024);
}

let reader: MemoryReader = readAvailableMb;

/** Replace the memory reader (a test, or null to restore the real one). */
export function setMemoryReader(r: MemoryReader | null): void {
  reader = r ?? readAvailableMb;
}

export function availableMemoryMb(): number {
  return reader();
}
