/**
 * Available memory, for the guard that refuses new turns when the machine is short of it (min_free_memory_mb).
 *
 * On Linux `os.freemem()` is MemFree, which leaves out the page cache the kernel would give back at once, so the
 * kernel's own estimate (MemAvailable) is read instead. Elsewhere `os.freemem()` is the best there is. The reader is
 * swappable so the guard can be tested with any number on any platform.
 */
import fs from "fs";
import os from "os";

export type MemoryReader = () => number;

/** Megabytes a new turn can count on. */
export function readAvailableMb(): number {
  if (process.platform === "linux") {
    try {
      const m = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (m) return Number(m[1]) / 1024;
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
