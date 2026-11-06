import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { useQuery } from "@tanstack/react-query";
import { get, url } from "@/lib/api";
import { qk } from "@/lib/queries";
import { bus } from "@/lib/bus";
import { fuzzyFilter } from "@/lib/fuzzy";
import { useUi } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { basename, dirname } from "@/lib/utils";
import { FileIcon } from "./FileIcon";
import { Dialog as D } from "radix-ui";

/** Highlight the matched characters of a path. */
function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const out: React.ReactNode[] = [];
  let run = "";
  let on = false;
  const flush = (key: number) => {
    if (run) out.push(on ? <mark key={key} className="bg-transparent font-semibold text-accent">{run}</mark> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== on) {
      flush(i);
      on = m;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

/** Cmd-P: jump to any file. `path:42` opens at a line. */
export function QuickOpen() {
  const { root } = useWorkspace();
  const openTab = useUi((s) => s.openTab);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => bus.on("open-quick-open", () => setOpen(true)), []);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const files = useQuery({
    queryKey: [...qk.fsAll(root), "find"],
    enabled: open,
    queryFn: () => get<{ files: string[] }>(url.fs(root, "find")).then((r) => r.files),
    staleTime: 20_000,
  });

  const { term, line } = useMemo(() => {
    const m = /^(.*?)(?::(\d+))?$/.exec(query);
    return { term: m?.[1] ?? query, line: m?.[2] ? Number(m[2]) : undefined };
  }, [query]);
  const matches = useMemo(() => fuzzyFilter(term, files.data ?? [], 50), [term, files.data]);

  const choose = (path: string) => {
    openTab({ kind: "file", root, path, title: basename(path), line });
    if (line) bus.emit("editor-goto", { path, line });
    setOpen(false);
  };

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/45 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <D.Content aria-describedby={undefined} className="fixed left-1/2 top-[14%] z-50 w-[620px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-pop outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-2 duration-150">
          <D.Title className="sr-only">Go to file</D.Title>
          <Command shouldFilter={false} loop>
            <Command.Input value={query} onValueChange={setQuery} placeholder="Go to file…   (add :line to jump)" className="h-11 w-full border-b border-line bg-transparent px-4 text-[14px] text-fg outline-none placeholder:text-fg-faint" />
            <Command.List className="max-h-[360px] overflow-y-auto p-1.5">
              {files.isLoading && <div className="px-3 py-6 text-center text-xs text-fg-faint">Indexing…</div>}
              {!files.isLoading && matches.length === 0 && <Command.Empty className="px-3 py-6 text-center text-xs text-fg-faint">No matching files</Command.Empty>}
              {matches.map((m) => {
                const name = basename(m.path);
                const dir = dirname(m.path);
                const offset = dir ? dir.length + 1 : 0;
                return (
                  <Command.Item key={m.path} value={m.path} onSelect={() => choose(m.path)} className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] data-[selected=true]:bg-active">
                    <FileIcon name={m.path} className="size-4" />
                    <span className="truncate">
                      <Highlighted text={name} indices={m.indices.filter((i) => i >= offset).map((i) => i - offset)} />
                    </span>
                    {dir && (
                      <span className="truncate font-mono text-[11px] text-fg-faint">
                        <Highlighted text={dir} indices={m.indices.filter((i) => i < dir.length)} />
                      </span>
                    )}
                  </Command.Item>
                );
              })}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
