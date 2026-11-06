import { useEffect, useRef, useState } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { toast } from "sonner";
import { get, url } from "@/lib/api";
import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";
import { basename } from "@/lib/utils";
import type { TerminalInfo } from "@/lib/types";
import { normalizeUrl, titleFor } from "../browser/logic";
import { THEME_VAR_NAMES, buildTermTheme, extractFileLinks, findInRows, type ThemeVars } from "./logic";
import { termHandles } from "./handles";

export type ConnState = "connecting" | "open" | "reconnecting" | "exited";

export function readTermTheme() {
  const cs = getComputedStyle(document.documentElement);
  const vars = Object.fromEntries(THEME_VAR_NAMES.map((n) => [n, cs.getPropertyValue(n).trim()])) as ThemeVars;
  return buildTermTheme(vars, document.documentElement.classList.contains("dark"));
}

const fontFamily = () => getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim() || "ui-monospace, Menlo, monospace";

/** Open `path` (relative to the terminal's root) in the editor, if it exists there. */
async function openFileLink(root: string, path: string, line?: number) {
  try {
    await get(url.fs(root, "file", { path }));
  } catch {
    toast.error(`${path} is not in this workspace`);
    return;
  }
  useUi.getState().openTab({ kind: "file", root, path, title: basename(path), line });
  if (line) bus.emit("editor-goto", { path, line });
}

function openUrl(uri: string) {
  const ui = { origin: location.origin, hostname: location.hostname, port: location.port };
  const r = normalizeUrl(uri, ui);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(uri);
  if (local && r.ok) useUi.getState().openTab({ kind: "browser", url: r.url, title: titleFor(r.url) });
  else if (local) toast.error(r.ok ? "Cannot preview that URL" : r.error);
  else window.open(uri, "_blank", "noopener,noreferrer");
}

interface Props {
  info: TerminalInfo;
  active: boolean;
  fontSize: number;
  theme: "dark" | "light";
  onState(id: string, state: ConnState, exitCode?: number | null): void;
}

/**
 * One xterm instance wired to one server-side terminal. It stays mounted while its tab is in the
 * background so its socket and scrollback survive tab switches; only the active one does layout work.
 */
export function TerminalView({ info, active, fontSize, theme, onState }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [state, setState] = useState<ConnState>("connecting");
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const initial = useRef({ fontSize, theme });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let exited = false;
    const subs: IDisposable[] = [];

    const term = new Terminal({
      fontFamily: fontFamily(),
      fontSize: initial.current.fontSize,
      lineHeight: 1.28,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: readTermTheme(),
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_e, uri) => openUrl(uri)));
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;

    const set = (s: ConnState, code?: number | null) => {
      setState(s);
      onStateRef.current(info.id, s, code);
    };
    const send = (m: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    const doFit = () => {
      if (!activeRef.current || el.clientWidth < 20 || el.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {}
    };

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/terminals/${info.id}/ws`);
      ws.onopen = () => {
        attempt = 0;
        set("open");
      };
      ws.onmessage = (e) => {
        let m: any;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.t === "replay") {
          // Replay at the size it was recorded, then fit to what we have now: wrapped lines then land where they were.
          term.reset();
          if (m.cols && m.rows) term.resize(m.cols, m.rows);
          term.write(m.d, () => doFit());
        } else if (m.t === "out") {
          term.write(m.d);
        } else if (m.t === "exit") {
          exited = true;
          term.write(`\r\n\x1b[2m[process exited${m.code === null || m.code === undefined ? "" : ` with code ${m.code}`}]\x1b[0m\r\n`);
          set("exited", m.code);
        }
      };
      ws.onclose = () => {
        if (disposed || exited) return;
        set("reconnecting");
        const delay = Math.min(5000, 400 * 2 ** attempt++);
        reconnect = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    subs.push(term.onData((d) => send({ type: "input", data: d })));
    subs.push(term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows })));

    // Copy on select (debounced: a drag fires many changes), the way every terminal behaves.
    let selTimer: ReturnType<typeof setTimeout> | null = null;
    subs.push(
      term.onSelectionChange(() => {
        if (selTimer) clearTimeout(selTimer);
        selTimer = setTimeout(() => {
          const s = term.getSelection();
          if (s) navigator.clipboard?.writeText(s).catch(() => {});
        }, 180);
      }),
    );

    // Keys: Ctrl-C copies only while text is selected (else it is the shell's interrupt). The app's own
    // shortcuts (Ctrl-` , Cmd-P/K/B/J/I, Alt-W ...) must reach the window, so xterm is told to ignore them.
    // Paste: xterm would send Ctrl-V to the shell as a literal ^V and cancel the browser's paste, so the
    // paste keys are handed back to the browser, which pastes into xterm's input.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const key = ev.key.toLowerCase();
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && !ev.altKey && key === "c" && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      if (mod && !ev.altKey && key === "v") return false;
      if (ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === "`") return false;
      if (ev.altKey && key === "w") return false;
      if (ev.metaKey && !ev.altKey && ["p", "k", "b", "j", "i", "e", "f", "g"].includes(key)) return false;
      return true;
    });

    subs.push(
      term.registerLinkProvider({
        provideLinks(y, cb) {
          const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
          const links = extractFileLinks(text, info.cwd).map((l) => ({
            range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
            text: text.slice(l.start, l.end),
            decorations: { underline: true, pointerCursor: true },
            activate: () => void openFileLink(info.rootRef, l.path, l.line),
          }));
          cb(links.length ? links : undefined);
        },
      }),
    );

    // Layout: refit on any size change, debounced, and only while visible.
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(doFit, 50);
    });
    ro.observe(el);
    // The monospace font may not be loaded when the terminal opens; re-measure once it is.
    void document.fonts?.ready.then(() => {
      if (disposed) return;
      term.options.fontFamily = fontFamily();
      doFit();
    });

    // Search state lives with the instance.
    let matches: Array<{ row: number; col: number; len: number }> = [];
    let at = -1;
    const rows = () => {
      const b = term.buffer.active;
      const out: string[] = [];
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
      return out;
    };
    const show = () => {
      const m = matches[at];
      if (!m) return;
      term.select(m.col, m.row, m.len);
      term.scrollToLine(Math.max(0, m.row - Math.floor(term.rows / 2)));
    };
    termHandles.set(info.id, {
      clear: () => term.clear(),
      focus: () => term.focus(),
      selectAll: () => term.selectAll(),
      copyOutput: async () => {
        const text = rows().join("\n").replace(/\n+$/, "");
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          return false;
        }
      },
      find: (q, cs) => {
        matches = findInRows(rows(), q, cs);
        at = matches.length ? 0 : -1;
        if (at === 0) show();
        else term.clearSelection();
        return { index: at, count: matches.length };
      },
      findStep: (dir) => {
        if (!matches.length) return { index: -1, count: 0 };
        at = (at + dir + matches.length) % matches.length;
        show();
        return { index: at, count: matches.length };
      },
      clearFind: () => {
        matches = [];
        at = -1;
        term.clearSelection();
      },
    });

    connect();
    return () => {
      disposed = true;
      termHandles.remove(info.id);
      if (reconnect) clearTimeout(reconnect);
      if (fitTimer) clearTimeout(fitTimer);
      if (selTimer) clearTimeout(selTimer);
      ro.disconnect();
      ws?.close();
      subs.forEach((s) => s.dispose());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [info.id, info.rootRef, info.cwd]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    if (active) requestAnimationFrame(() => fitRef.current?.fit());
  }, [fontSize, active]);

  // Re-theme when the app theme flips (the class on <html> is already updated by the time this runs).
  const palette = useUi((s) => s.palette);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = readTermTheme();
  }, [theme, palette]);

  // Becoming visible: measure, and take the keyboard.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {}
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full" data-terminal={info.id} />
      {state === "reconnecting" && <div className="absolute bottom-2 left-3 animate-slide-up rounded-md border border-line-strong bg-overlay px-2 py-1 font-mono text-[11px] text-amber">Reconnecting…</div>}
    </div>
  );
}
