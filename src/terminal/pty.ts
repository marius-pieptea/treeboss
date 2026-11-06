/**
 * Terminals: real PTYs (Bun's native terminal support) that outlive the browser tab.
 *
 * A terminal is created by an API call and lives until its shell exits or it is killed. Output is kept in
 * a bounded scrollback so reloading the page, or opening the same terminal elsewhere, replays what was
 * on screen instead of showing an empty prompt. Clients attach over a WebSocket (routes/terminal.ts).
 */
import fs from "fs";
import os from "os";
import { newId } from "../util";
import { killTree } from "../proctree";

const MAX_SCROLLBACK_CHARS = 400_000;
const MAX_TERMINALS = 24;

export interface TerminalInfo {
  id: string;
  rootRef: string;
  cwd: string;
  title: string;
  command: string[];
  cols: number;
  rows: number;
  createdAt: string;
  alive: boolean;
  exitCode: number | null;
}

interface Term extends TerminalInfo {
  proc: any;
  /** Input/resize go through these so a PTY-less fallback (Windows) can share the rest. */
  write: (data: string) => void;
  resizePty: (cols: number, rows: number) => void;
  scrollback: string[];
  scrollbackChars: number;
  listeners: Set<(msg: { t: "out"; d: string } | { t: "exit"; code: number | null }) => void>;
  decoder: TextDecoder;
}

const terms = new Map<string, Term>();

function defaultShell(): string {
  if (process.platform === "win32") return process.env.ComSpec || "powershell.exe";
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(Boolean) as string[];
  return candidates.find((c) => fs.existsSync(c)) ?? "/bin/sh";
}

export interface CreateTerminalInput {
  rootRef: string;
  cwd: string;
  cols?: number;
  rows?: number;
  title?: string;
  /** Run this instead of a login shell (e.g. an engine's interactive resume). */
  command?: string[];
  env?: Record<string, string>;
}

export function createTerminal(input: CreateTerminalInput): TerminalInfo {
  const live = [...terms.values()].filter((t) => t.alive).length;
  if (live >= MAX_TERMINALS) throw new Error(`Too many terminals open (${MAX_TERMINALS}). Close some first.`);
  const cols = Math.min(Math.max(input.cols ?? 80, 20), 500);
  const rows = Math.min(Math.max(input.rows ?? 24, 5), 200);
  const shell = defaultShell();
  const command = input.command ?? (process.platform === "win32" ? [shell] : [shell, "-l"]);
  const id = newId("term");

  const term = {
    id,
    rootRef: input.rootRef,
    cwd: input.cwd,
    title: input.title ?? (input.command ? input.command[0] : shell.split(/[\\/]/).pop()!),
    command,
    cols,
    rows,
    createdAt: new Date().toISOString(),
    alive: true,
    exitCode: null,
    proc: null,
    write: () => {},
    resizePty: () => {},
    scrollback: [],
    scrollbackChars: 0,
    listeners: new Set(),
    decoder: new TextDecoder("utf-8"),
  } as Term;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8",
    ...input.env,
  };
  // The daemon's own credentials are not for the shells it hands out.
  delete env.TRB_TOKEN;

  const emit = (chunk: string) => {
    if (!chunk) return;
    term.scrollback.push(chunk);
    term.scrollbackChars += chunk.length;
    while (term.scrollbackChars > MAX_SCROLLBACK_CHARS && term.scrollback.length > 1) term.scrollbackChars -= term.scrollback.shift()!.length;
    for (const l of term.listeners) l({ t: "out", d: chunk });
  };

  try {
    term.proc = Bun.spawn(command, {
      cwd: input.cwd,
      env,
      terminal: {
        cols,
        rows,
        data(_t: unknown, data: Uint8Array) {
          emit(term.decoder.decode(data, { stream: true }));
        },
      },
    });
    term.write = (d) => term.proc.terminal.write(d);
    term.resizePty = (c, r) => term.proc.terminal.resize(c, r);
  } catch (e) {
    // Bun's PTY is POSIX-only. On Windows fall back to plain pipes: output and dev servers work, but
    // there is no line editing from the shell, so echo and basic editing are done here.
    if (process.platform !== "win32") throw e;
    const proc = Bun.spawn(command, { cwd: input.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    term.proc = proc;
    const pump = async (s: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder("utf-8");
      for await (const chunk of s) emit(dec.decode(chunk, { stream: true }).replace(/\r?\n/g, "\r\n"));
    };
    void pump(proc.stdout as ReadableStream<Uint8Array>);
    void pump(proc.stderr as ReadableStream<Uint8Array>);
    let line = "";
    term.write = (d) => {
      for (const ch of d) {
        if (ch === "\r" || ch === "\n") {
          emit("\r\n");
          proc.stdin.write(line + "\r\n");
          proc.stdin.flush();
          line = "";
        } else if (ch === "\x7f" || ch === "\b") {
          if (line) {
            line = line.slice(0, -1);
            emit("\b \b");
          }
        } else if (ch === "\x03") {
          emit("^C\r\n");
          line = "";
          killTree(proc.pid, "SIGTERM");
        } else if (ch >= " ") {
          line += ch;
          emit(ch);
        }
      }
    };
    term.resizePty = () => {};
  }
  term.proc.exited.then((code: number) => {
    term.alive = false;
    term.exitCode = code;
    for (const l of term.listeners) l({ t: "exit", code });
  });
  terms.set(id, term);
  return info(term);
}

function info(t: Term): TerminalInfo {
  const { proc: _p, write: _w, resizePty: _r, scrollback: _s, scrollbackChars: _c, listeners: _l, decoder: _d, ...rest } = t;
  return rest;
}

export function listTerminals(rootRef?: string): TerminalInfo[] {
  return [...terms.values()].filter((t) => !rootRef || t.rootRef === rootRef).map(info);
}

/** Live shells' pids with their working directories: lets port detection attribute a server to a workspace where the OS cannot say. */
export function terminalRoots(): Array<{ pid: number; cwd: string }> {
  return [...terms.values()].filter((t) => t.alive && t.proc?.pid).map((t) => ({ pid: t.proc.pid as number, cwd: t.cwd }));
}

export function getTerminal(id: string): TerminalInfo | null {
  const t = terms.get(id);
  return t ? info(t) : null;
}

export function terminalScrollback(id: string): string {
  return terms.get(id)?.scrollback.join("") ?? "";
}

export function writeTerminal(id: string, data: string): boolean {
  const t = terms.get(id);
  if (!t?.alive) return false;
  t.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const t = terms.get(id);
  if (!t?.alive) return;
  t.cols = Math.min(Math.max(Math.floor(cols), 20), 500);
  t.rows = Math.min(Math.max(Math.floor(rows), 5), 200);
  t.resizePty(t.cols, t.rows);
}

export function subscribeTerminal(id: string, l: Term["listeners"] extends Set<infer F> ? F : never): (() => void) | null {
  const t = terms.get(id);
  if (!t) return null;
  t.listeners.add(l);
  return () => t.listeners.delete(l);
}

export function renameTerminal(id: string, title: string): void {
  const t = terms.get(id);
  if (t) t.title = title.slice(0, 60);
}

/** Kill the shell and forget the terminal. */
export function killTerminal(id: string): boolean {
  const t = terms.get(id);
  if (!t) return false;
  if (t.alive) {
    const pid: number | undefined = t.proc.pid;
    // Windows has no SIGHUP and no process group: take the whole tree down so dev servers don't linger.
    if (process.platform === "win32") killTree(pid, "SIGKILL");
    else {
      try {
        t.proc.kill("SIGHUP");
      } catch {}
      setTimeout(() => {
        try {
          if (t.alive) t.proc.kill("SIGKILL");
        } catch {}
      }, 1500).unref?.();
    }
  }
  terms.delete(id);
  return true;
}

export function killAllTerminals(): void {
  for (const id of [...terms.keys()]) killTerminal(id);
}

export const homeDir = os.homedir;
