import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, ChevronRight, CheckCheck, FileDiff, FileText, Link2, Paperclip, Pencil, Eye, Sparkles, FileX } from "lucide-react";
import { url, ApiError } from "@/lib/api";
import { useGitStatus } from "@/lib/queries";
import { useUi, useWs, type Tab } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { FileTab } from "@/features/editor/FileTab";
import { bus } from "@/lib/bus";
import { useAttachActions, useDocActions, useDocs, usePage, useSessionDocs } from "./data";
import { useGenerateDialog } from "./GenerateDialog";
import { classifyLink, FRESHNESS_LABEL, freshnessTone, headerLine, hideComments, resolveLink, stripFrontMatter, type Backlink, type ChangedFile } from "./logic";

type DocTab = Extract<Tab, { kind: "doc" }>;

const STATUS_MARK: Record<ChangedFile["status"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R" };

/** A page rendered: links to other pages open in the viewer, links to code in the editor, images through the raw endpoint. */
export function DocMarkdown({ text, root, path, docsDir }: { text: string; root: string; path: string; docsDir: string }) {
  const openTab = useUi((s) => s.openTab);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (
    <div className="markdown mx-auto max-w-[820px] px-8 py-6 [&_h1]:border-b [&_h1]:border-line [&_h1]:pb-2 [&_h1]:text-[1.7em] [&_h2]:text-[1.35em] [&_li::marker]:text-fg-faint [&_ol]:list-decimal [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const t = classifyLink(href, path, docsDir);
            if (t.kind === "doc") {
              return (
                <a
                  href={href}
                  data-doc-link={t.path}
                  onClick={(e) => {
                    e.preventDefault();
                    openTab({ kind: "doc", root, path: t.path, title: t.path.replace(/^.*\//, "") });
                  }}
                >
                  {children}
                </a>
              );
            }
            if (t.kind === "file") {
              return (
                <a
                  href={href}
                  data-file-link={t.path}
                  onClick={(e) => {
                    e.preventDefault();
                    openTab({ kind: "file", root, path: t.path, title: t.path.replace(/^.*\//, "") });
                  }}
                >
                  {children}
                </a>
              );
            }
            if (t.kind === "anchor") return <a href={href}>{children}</a>;
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          img: ({ src, alt }) => {
            const rel = typeof src === "string" ? resolveLink(dir, src) : null;
            return <img src={rel !== null ? url.fs(root, "raw", { path: rel }) : typeof src === "string" ? src : undefined} alt={alt ?? ""} className="max-w-full rounded-md" loading="lazy" />;
          },
        }}
      >
        {hideComments(stripFrontMatter(text))}
      </ReactMarkdown>
    </div>
  );
}

function Backlinks({ items, root }: { items: Backlink[]; root: string }) {
  const openTab = useUi((s) => s.openTab);
  if (items.length === 0) return null;
  return (
    <div className="border-t border-line px-4 py-2" data-doc-backlinks>
      <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
        <Link2 className="size-3" /> Mentioned in
      </div>
      <ul className="flex flex-col">
        {items.map((b, i) => (
          <li key={`${b.path}:${b.line}:${i}`}>
            <button onClick={() => openTab({ kind: "file", root, path: b.path, title: b.path.replace(/^.*\//, ""), line: b.line })} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] outline-none hover:bg-hover focus-visible:bg-hover">
              <Badge tone={b.kind === "spec" ? "violet" : "blue"}>{b.kind}</Badge>
              <span className="shrink-0 font-mono text-fg-muted">
                {b.path}:{b.line}
              </span>
              <span className="min-w-0 flex-1 truncate text-fg-faint">{b.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A documentation page: rendered, with how fresh it is and what to do about it; the editor is one toggle away. */
export function DocViewer({ tab }: { tab: DocTab }) {
  const root = tab.root;
  const ws = useWs();
  const openTab = useUi((s) => s.openTab);
  const [editing, setEditing] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const q = usePage(root, tab.path, !editing);
  const git = useGitStatus(root);
  const actions = useDocActions(root);
  const gen = useGenerateDialog(root);
  const attached = useSessionDocs(ws.activeSession);
  const { attach, detach } = useAttachActions(ws.activeSession);
  const docs = useDocs(root);
  const docsDir = docs.data?.docs.dir ?? tab.path.split("/")[0];
  const fileTab = { id: tab.id, kind: "file" as const, root, path: tab.path, title: tab.title };

  const gone = q.error instanceof ApiError && q.error.status === 404;
  const dirty = (git.data?.files ?? []).some((f) => f.path === tab.path);
  const d = q.data;
  const st = d?.staleness;
  const revealCovered = (c: string) => {
    const base = c.replace(/\/?[*?[{].*$/, "").replace(/\/$/, "");
    useUi.getState().setActivity("explorer");
    if (base) setTimeout(() => bus.emit("reveal-in-explorer", { path: base }), 60);
  };
  const isAttached = !!attached.data?.attached.some((a) => a.doc_path === tab.path);

  const bar = (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-[14px] font-semibold">{d?.page.title ?? tab.title}</h1>
          {st && st.state !== "unmanaged" && (
            <span data-doc-fresh={st.state}>
              <Badge tone={freshnessTone(st.state)} title={st.reason ?? undefined}>
                {FRESHNESS_LABEL[st.state]}
              </Badge>
            </span>
          )}
          {d?.page.meta.status && <Badge>{d.page.meta.status}</Badge>}
        </div>
        <div className="truncate font-mono text-[11px] text-fg-faint">{tab.path}</div>
      </div>
      <Button size="xs" variant="outline" data-doc-refresh onClick={() => gen.start({ kind: "refresh", page: tab.path, locked: true })} disabled={!d}>
        <Sparkles /> Refresh
      </Button>
      <Button size="xs" variant="ghost" data-doc-current title="Record that this page is current as of HEAD" disabled={!d || d.page.meta.covers.length === 0 || actions.markCurrent.isPending} onClick={() => actions.markCurrent.mutate(tab.path)}>
        <CheckCheck /> Mark current
      </Button>
      <Button size="xs" variant={isAttached ? "subtle" : "ghost"} data-doc-attach disabled={!ws.activeSession} title={ws.activeSession ? (isAttached ? "Detach from the open session" : "Give the open session a pointer to this page") : "Open a session to attach this page"} onClick={() => (isAttached ? detach.mutate(tab.path) : attach.mutate({ path: tab.path, mode: "ref" }))}>
        <Paperclip /> {isAttached ? "Attached" : "Attach"}
      </Button>
      <Button size="xs" variant={editing ? "subtle" : "ghost"} data-doc-edit aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
        {editing ? <Eye /> : <Pencil />} {editing ? "Preview" : "Edit"}
      </Button>
    </div>
  );

  if (gone && !editing) {
    return (
      <div className="flex h-full flex-col">
        <Empty icon={<FileX />} title="This page no longer exists" hint={<span className="font-mono">{tab.path}</span>} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-doc-viewer={tab.path}>
      {bar}
      {!editing && d && (
        <div className="shrink-0 border-b border-line px-4 py-1.5 text-[12px]">
          <div className="flex items-center gap-1.5 text-fg-muted" data-doc-headerline>
            <button type="button" aria-expanded={showFiles} disabled={!st || st.files.length === 0} onClick={() => setShowFiles((v) => !v)} className="flex items-center gap-1 outline-none enabled:hover:text-fg disabled:cursor-default">
              <ChevronRight className={cn("size-3 transition-transform duration-150", showFiles && "rotate-90", (!st || st.files.length === 0) && "opacity-0")} />
              <span>{headerLine(d.page, st)}</span>
            </button>
          </div>
          {showFiles && st && st.files.length > 0 && (
            <ul className="mt-1 max-h-32 overflow-y-auto pl-4 font-mono text-[11px]" data-doc-changed>
              {st.files.map((f) => (
                <li key={`${f.status}:${f.path}`}>
                  <button onClick={() => openTab({ kind: "file", root, path: f.path, title: f.path.replace(/^.*\//, "") })} disabled={f.status === "deleted"} className="flex items-center gap-2 outline-none enabled:hover:text-accent">
                    <span className={cn("w-3 text-center", f.status === "deleted" ? "text-red" : f.status === "added" ? "text-green" : "text-amber")}>{STATUS_MARK[f.status]}</span>
                    <span>{f.from ? `${f.from} → ${f.path}` : f.path}</span>
                  </button>
                </li>
              ))}
              {st.filesChanged > st.files.length && <li className="text-fg-faint">… {st.filesChanged - st.files.length} more</li>}
            </ul>
          )}
          {d.page.meta.covers.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1" data-doc-covers>
              <span className="text-[10.5px] uppercase tracking-[0.08em] text-fg-faint">Covers</span>
              {d.page.meta.covers.map((c) => (
                <button key={c} onClick={() => revealCovered(c)} title="Reveal in the explorer" className="rounded border border-line bg-raised px-1.5 font-mono text-[10.5px] text-fg-muted outline-none hover:border-accent hover:text-accent focus-visible:border-accent">
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {!editing && dirty && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber/30 bg-amber/10 px-4 py-1.5 text-[12px]" data-doc-dirty>
          <FileDiff className="size-3.5 text-amber" />
          <span className="flex-1">This page has changes that are not committed yet.</span>
          <Button size="xs" variant="outline" onClick={() => openTab({ kind: "diff", root, path: tab.path, title: `${tab.title} (changes)` })}>
            View the diff
          </Button>
        </div>
      )}
      {!editing && d?.page.frontMatterError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber/30 bg-amber/10 px-4 py-1.5 text-[12px] text-amber">
          <AlertTriangle className="size-3.5" /> The front matter does not parse ({d.page.frontMatterError}), so freshness cannot be tracked.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {editing ? (
          <FileTab tab={fileTab} />
        ) : q.isPending ? (
          <div className="mx-auto flex max-w-[820px] flex-col gap-3 px-8 py-6">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4" />
            <Skeleton className="h-4" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : q.error ? (
          <Empty icon={<FileText />} title="Could not open this page" hint={(q.error as Error).message} action={<Button size="sm" variant="outline" onClick={() => void q.refetch()}>Try again</Button>} />
        ) : d ? (
          <DocMarkdown text={d.page.content} root={root} path={tab.path} docsDir={docsDir} />
        ) : null}
      </div>
      {!editing && d && <Backlinks items={d.backlinks} root={root} />}
      {gen.dialog}
    </div>
  );
}
