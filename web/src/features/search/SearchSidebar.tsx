import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CaseSensitive, ChevronRight, Regex, Search, WholeWord, X } from "lucide-react";
import { get, url } from "@/lib/api";
import { bus } from "@/lib/bus";
import { useDebounced } from "@/lib/hooks";
import { useUi } from "@/lib/store";
import { editorFocus } from "../editor/buffers";
import type { GrepMatch } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";
import { basename, cn, dirname } from "@/lib/utils";
import { Empty, Spinner } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/overlay";
import { FileIcon } from "@/shell/FileIcon";
import { buildMatcher, excerpt, findSpans, flattenResults, groupMatches, normalizeInclude, regexError, type ResultRow } from "./logic";
import { useSearch } from "./store";

interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  engine: string;
}

function Toggle({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip label={label}>
      <button onClick={onClick} aria-pressed={on} aria-label={label} className={cn("flex size-[22px] shrink-0 items-center justify-center rounded outline-none transition-colors [&_svg]:size-3.5", on ? "bg-accent-soft text-accent ring-1 ring-accent/40" : "text-fg-faint hover:bg-hover hover:text-fg")}>
        {children}
      </button>
    </Tooltip>
  );
}

function Highlighted({ text, spans }: { text: string; spans: Array<[number, number]> }) {
  if (!spans.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  spans.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <mark key={i} className="rounded-[3px] bg-amber/25 px-px text-fg ring-1 ring-amber/30">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

export function SearchSidebar() {
  const { root } = useWorkspace();
  const openTab = useUi((s) => s.openTab);
  const { query, include, caseSensitive, wholeWord, regex, focusTick, setQuery, setInclude, toggle } = useSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(-1);

  // Opening the sidebar, or asking for "find in files", puts the cursor in the query box.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  const flags = { regex, caseSensitive, wholeWord };
  const q = useDebounced(query, 250);
  const inc = useDebounced(normalizeInclude(include), 250);
  const badRegex = regexError(q, flags);
  const search = useQuery({
    queryKey: ["fs", root, "grep", q, inc, regex, caseSensitive, wholeWord],
    enabled: q.length > 0 && !badRegex,
    queryFn: () => get<GrepResult>(url.fs(root, "grep", { q, regex, case: caseSensitive, word: wholeWord, include: inc })),
    placeholderData: keepPreviousData,
    staleTime: 5000,
    retry: false,
  });

  const matcher = useMemo(() => buildMatcher(q, flags), [q, regex, caseSensitive, wholeWord]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupMatches(search.data?.matches ?? []), [search.data]);
  const rows = useMemo(() => flattenResults(groups, collapsed), [groups, collapsed]);
  useEffect(() => setActive(-1), [search.data]);

  const openMatch = (m: GrepMatch, pin: boolean) => {
    if (pin) editorFocus.request();
    const col = findSpans(m.text, matcher)[0]?.[0];
    const column = col !== undefined ? col + 1 : m.column;
    openTab({ kind: "file", root, path: m.path, title: basename(m.path), line: m.line, preview: !pin });
    bus.emit("editor-goto", { path: m.path, line: m.line, column });
  };

  const activate = (i: number, pin = false) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === "file") {
      setCollapsed((c) => {
        const n = new Set(c);
        n.has(r.path) ? n.delete(r.path) : n.add(r.path);
        return n;
      });
    } else openMatch(r.match, pin);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (active <= 0) inputRef.current?.focus();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(active, true);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const r = rows[active];
      if (r?.kind === "file" && (e.key === "ArrowLeft") !== r.collapsed) {
        e.preventDefault();
        activate(active);
      }
    } else if (e.key === "Escape") inputRef.current?.focus();
  };

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const total = search.data?.matches.length ?? 0;
  const typing = query !== q;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center pl-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Search</div>
      <div className="flex flex-col gap-1.5 px-2.5 pb-2">
        <div className={cn("flex items-center gap-1 rounded-md border bg-raised pl-2 pr-1 transition-colors focus-within:!border-accent/70 focus-within:bg-panel", badRegex && "!border-red")}>
          <Search className="size-3.5 shrink-0 text-fg-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && rows.length) {
                e.preventDefault();
                setActive(0);
                listRef.current?.focus();
              } else if (e.key === "Escape" && query) setQuery("");
            }}
            placeholder="Search in files"
            spellCheck={false}
            aria-label="Search query"
            className="h-7 min-w-0 flex-1 bg-transparent px-1 text-[12.5px] outline-none placeholder:text-fg-faint"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search" className="flex size-[22px] items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg">
              <X className="size-3.5" />
            </button>
          )}
          <Toggle on={caseSensitive} label="Match case" onClick={() => toggle("caseSensitive")}>
            <CaseSensitive />
          </Toggle>
          <Toggle on={wholeWord} label="Match whole word" onClick={() => toggle("wholeWord")}>
            <WholeWord />
          </Toggle>
          <Toggle on={regex} label="Use regular expression" onClick={() => toggle("regex")}>
            <Regex />
          </Toggle>
        </div>
        <input value={include} onChange={(e) => setInclude(e.target.value)} placeholder="Files to include, e.g. src/**, *.ts, !*.test.ts" spellCheck={false} aria-label="Files to include" className="h-7 w-full rounded-md border border-line bg-raised px-2 font-mono text-[11.5px] outline-none transition-colors placeholder:font-sans placeholder:text-fg-faint hover:!border-line-strong focus:!border-accent/70 focus:bg-panel" />
        {badRegex && <div className="px-0.5 text-[11px] text-red">{badRegex}</div>}
      </div>

      <div className="flex h-6 shrink-0 items-center justify-between border-y border-line px-3 font-mono text-[10.5px] text-fg-faint">
        <span>
          {!q ? "Type to search" : search.isFetching && !search.data ? "Searching…" : search.error ? "Search failed" : `${total}${search.data?.truncated ? "+" : ""} result${total === 1 ? "" : "s"} in ${groups.length} file${groups.length === 1 ? "" : "s"}`}
        </span>
        <span className="flex items-center gap-1.5">
          {(search.isFetching || typing) && q && <Spinner className="size-3" />}
          {search.data && search.data.engine !== "none" && <span title="Search engine used">{search.data.engine}</span>}
        </span>
      </div>

      <div ref={listRef} tabIndex={0} role="tree" aria-label="Search results" onKeyDown={onListKey} className="min-h-0 flex-1 overflow-y-auto py-1 outline-none">
        {search.error && <div className="m-3 rounded-md border border-red/30 bg-red/10 p-2.5 text-xs text-red">{(search.error as Error).message}</div>}
        {q && !search.isFetching && !search.error && !badRegex && total === 0 && <Empty icon={<Search />} title="No results" hint={`Nothing matches "${q}"${inc ? ` in ${inc}` : ""}.`} />}
        {!q && <Empty icon={<Search />} title="Find in files" hint="Search every file in the workspace. Ignored files are skipped." />}
        {rows.map((r, i) => (
          <ResultLine key={r.kind === "file" ? `f:${r.path}` : `m:${r.path}:${r.match.line}:${r.match.column}`} row={r} index={i} active={i === active} matcher={matcher} onClick={() => (setActive(i), activate(i))} onDouble={() => activate(i, true)} />
        ))}
        {search.data?.truncated && <div className="px-3 py-2 text-center text-[11px] text-amber">Showing the first {total} matches. Narrow the search to see the rest.</div>}
      </div>
    </div>
  );
}

function ResultLine({ row, index, active, matcher, onClick, onDouble }: { row: ResultRow; index: number; active: boolean; matcher: RegExp | null; onClick: () => void; onDouble: () => void }) {
  if (row.kind === "file") {
    const dir = dirname(row.path);
    return (
      <div role="treeitem" aria-expanded={!row.collapsed} data-row={index} onClick={onClick} className={cn("flex h-6 cursor-default items-center gap-1 px-2 text-[12.5px] transition-colors", active ? "bg-active" : "hover:bg-hover")}>
        <ChevronRight className={cn("size-3 shrink-0 text-fg-faint transition-transform duration-150", !row.collapsed && "rotate-90")} />
        <FileIcon name={row.path} className="size-3.5" />
        <span className="truncate font-medium">{basename(row.path)}</span>
        {dir && <span className="truncate font-mono text-[10.5px] text-fg-faint">{dir}</span>}
        <span className="ml-auto shrink-0 rounded bg-raised px-1.5 font-mono text-[10px] text-fg-muted">{row.count}</span>
      </div>
    );
  }
  const spans = findSpans(row.match.text, matcher);
  const ex = excerpt(row.match.text, spans);
  return (
    <div role="treeitem" data-row={index} onClick={onClick} onDoubleClick={onDouble} className={cn("flex h-[22px] cursor-default items-center gap-2 pl-7 pr-2 transition-colors", active ? "bg-active" : "hover:bg-hover")}>
      <span className="w-7 shrink-0 text-right font-mono text-[10.5px] text-fg-faint">{row.match.line}</span>
      <span className="min-w-0 truncate whitespace-pre font-mono text-[11.5px] text-fg-muted">
        <Highlighted text={ex.text} spans={ex.spans} />
      </span>
    </div>
  );
}
