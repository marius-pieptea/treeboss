import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookText, ChevronRight, FilePlus2, FileText, Folder, FolderPlus, Gavel, Paperclip, RefreshCw, Search, Settings2, Sparkles } from "lucide-react";
import { bus } from "@/lib/bus";
import { get, url } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { useUi, useWs } from "@/lib/store";
import { useGitStatus } from "@/lib/queries";
import type { GrepMatch } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge, Empty, Skeleton, Spinner } from "@/components/ui/misc";
import { Button, IconButton } from "@/components/ui/button";
import { ContextMenu, Dialog } from "@/components/ui/overlay";
import { Field, Input } from "@/components/ui/form";
import { docKey, useAttachActions, useDocActions, useDocs, useDocsRun, useLastRun } from "./data";
import { buildTree, filterPages, freshnessColor, FRESHNESS_LABEL, runSummary, summarize, type DocsOverview, type PageInfo, type Staleness, type TreeFolder } from "./logic";
import { NewPageDialog } from "./NewPageDialog";
import { useGenerateDialog } from "./GenerateDialog";

function Dot({ page, st }: { page: PageInfo; st: Staleness | undefined }) {
  const state = st?.state ?? "unmanaged";
  const why = st ? (st.state === "unknown" || st.state === "unmanaged" ? (st.reason ?? FRESHNESS_LABEL[st.state]) : st.state === "fresh" ? "Up to date" : `${FRESHNESS_LABEL[st.state]}: ${st.filesChanged} covered files changed in ${st.commitsBehind} commits`) : page.managed ? "Checking…" : "Not tracked: no commit or covers in its front matter";
  return <span title={why} aria-label={FRESHNESS_LABEL[state]} data-fresh={state} style={{ background: freshnessColor(state) }} className={cn("size-[7px] shrink-0 rounded-full", (state === "unmanaged" || state === "unknown") && "opacity-50")} />;
}

function PageRow({ page, st, depth, active, dirty, onOpen, onRefresh, onAttach, onCurrent, canAttach }: { page: PageInfo; st: Staleness | undefined; depth: number; active: boolean; dirty: boolean; onOpen: () => void; onRefresh: () => void; onAttach: () => void; onCurrent: () => void; canAttach: boolean }) {
  const Icon = page.kind === "adr" ? Gavel : page.kind === "index" ? BookText : FileText;
  return (
    <ContextMenu
      entries={[
        { label: "Open", onSelect: onOpen },
        { separator: true },
        { label: "Refresh with an agent…", icon: <Sparkles />, onSelect: onRefresh },
        { label: "Attach to the open session", icon: <Paperclip />, disabled: !canAttach, onSelect: onAttach },
        { label: "Record as current as of HEAD", disabled: page.meta.covers.length === 0, onSelect: onCurrent },
        { separator: true },
        { label: "Copy path", onSelect: () => void navigator.clipboard.writeText(page.path) },
      ]}
    >
      <button data-doc-page={page.path} onClick={onOpen} style={{ paddingLeft: 8 + depth * 12 }} className={cn("group relative flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12.5px] outline-none transition-colors hover:bg-hover focus-visible:bg-hover", active && "bg-active")}>
        {active && <span className="absolute left-0 top-1 h-[calc(100%-0.5rem)] w-[2px] rounded-r bg-accent" />}
        <Dot page={page} st={st} />
        <Icon className="size-3.5 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{page.title}</span>
        {page.frontMatterError && (
          <span title={`Front matter does not parse: ${page.frontMatterError}`} className="text-amber">
            <AlertTriangle className="size-3" />
          </span>
        )}
        {dirty && <span title="Changed since the last commit" className="font-mono text-[10px] text-amber">M</span>}
      </button>
    </ContextMenu>
  );
}

function FolderRows({ folder, depth, collapsed, toggle, row }: { folder: TreeFolder; depth: number; collapsed: Set<string>; toggle: (p: string) => void; row: (p: PageInfo, depth: number) => React.ReactNode }) {
  return (
    <>
      {folder.folders.map((f) => {
        const closed = collapsed.has(f.path);
        return (
          <div key={f.path}>
            <button onClick={() => toggle(f.path)} aria-expanded={!closed} style={{ paddingLeft: 4 + depth * 12 }} className="flex w-full items-center gap-1 py-1 pr-2 text-left text-[12px] font-medium text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover">
              <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", !closed && "rotate-90")} />
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate">{f.name}</span>
              <span className="ml-auto font-mono text-[10px] text-fg-faint">{countPages(f)}</span>
            </button>
            {!closed && <FolderRows folder={f} depth={depth + 1} collapsed={collapsed} toggle={toggle} row={row} />}
          </div>
        );
      })}
      {folder.pages.map((p) => row(p, depth))}
    </>
  );
}

const countPages = (f: TreeFolder): number => f.pages.length + f.folders.reduce((n, x) => n + countPages(x), 0);

/** What the last generation run did: pages written, and what needs a look. */
function LastRun({ root }: { root: string }) {
  const session = useLastRun((s) => s.session);
  const openTab = useUi((s) => s.openTab);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const q = useDocsRun(root, session, true);
  const result = q.data?.run.result ?? null;
  useEffect(() => void (session && setDismissed((d) => (d === session ? d : null))), [session]);
  if (!session || dismissed === session) return null;
  const sum = runSummary(result);
  return (
    <div className="mx-2 mb-2 rounded-lg border border-line bg-raised" data-docs-last-run>
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        {!result ? <Spinner className="size-3" /> : <span className={cn("size-2 rounded-full", sum.tone === "green" ? "bg-green" : sum.tone === "amber" ? "bg-amber" : "bg-fg-faint")} />}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">Last run: {sum.line}</span>
        <button aria-label="Dismiss" onClick={() => setDismissed(session)} className="text-fg-faint hover:text-fg">×</button>
      </div>
      {result && (
        <ul className="border-t border-line p-1">
          {result.touched.map((t) => (
            <li key={t.path}>
              <button onClick={() => openTab({ kind: "doc", root, path: t.path, title: t.path.replace(/^.*\//, "") })} className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] outline-none hover:bg-hover">
                <FileText className="size-3.5 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate font-mono">{t.path.replace(/^.*\//, "")}</span>
                {t.created && <Badge tone="accent">new</Badge>}
                {t.issues.length > 0 && <Badge tone="amber" title={t.issues.map((i) => i.message).join("\n")}>{t.issues.length} to check</Badge>}
              </button>
            </li>
          ))}
          {result.stray.length > 0 && <li className="px-1.5 py-1 text-[11.5px] text-amber">Changed outside the docs folder: {result.stray.slice(0, 3).join(", ")}{result.stray.length > 3 ? ", …" : ""}</li>}
          {result.reportedOnly.length > 0 && <li className="px-1.5 py-1 text-[11.5px] text-amber">Reported but unchanged: {result.reportedOnly.join(", ")}</li>}
          {sum.pages > 0 && <li className="px-1.5 pb-1 pt-0.5 text-[11px] text-fg-muted">Review the diff in Source Control, then commit.</li>}
        </ul>
      )}
    </div>
  );
}

/** Text search through the docs folder, for when the title is not what you remember. */
function TextHits({ root, dir, q, onOpen }: { root: string; dir: string; q: string; onOpen: (path: string, line: number) => void }) {
  const hits = useQuery({
    queryKey: ["docs", root, "grep", dir, q],
    enabled: q.trim().length >= 3,
    queryFn: () => get<{ matches: GrepMatch[]; truncated: boolean }>(url.fs(root, "grep", { q: q.trim(), include: `${dir}/**` })),
    staleTime: 3000,
  });
  if (q.trim().length < 3) return null;
  const rows = hits.data?.matches.filter((m) => /\.(md|mdx|markdown)$/i.test(m.path)).slice(0, 30) ?? [];
  return (
    <div className="border-t border-line pt-1">
      <div className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-faint">In the text {hits.isFetching && <Spinner className="ml-1 inline size-3" />}</div>
      {!hits.isFetching && rows.length === 0 && <p className="px-3 py-1 text-xs text-fg-muted">No page contains “{q.trim()}”.</p>}
      {rows.map((m, i) => (
        <button key={`${m.path}:${m.line}:${i}`} onClick={() => onOpen(m.path, m.line)} className="flex w-full flex-col gap-0.5 px-3 py-1 text-left outline-none hover:bg-hover focus-visible:bg-hover">
          <span className="truncate font-mono text-[11px] text-fg-muted">
            {m.path.replace(`${dir}/`, "")}:{m.line}
          </span>
          <span className="truncate text-[12px]">{m.text.trim()}</span>
        </button>
      ))}
    </div>
  );
}

/** The Docs view: the pages, how fresh each one is, and the actions that write and refresh them. */
export function DocsSidebar() {
  const { root } = useWorkspace();
  const ws = useWs();
  const openTab = useUi((s) => s.openTab);
  const qc = useQueryClient();
  const docs = useDocs(root);
  const git = useGitStatus(root);
  const actions = useDocActions(root);
  const gen = useGenerateDialog(root);
  const attach = useAttachActions(ws.activeSession);
  const [q, setQ] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [newOpen, setNewOpen] = useState<"page" | "adr" | null>(null);
  const [dirOpen, setDirOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const o: DocsOverview | undefined = docs.data?.docs;
  const staleness = docs.data?.staleness ?? {};

  useEffect(() => bus.on("docs-new-page", () => setNewOpen("page")), []);
  useEffect(() => bus.on("docs-new-adr", () => setNewOpen("adr")), []);
  useEffect(() => bus.on("docs-generate", () => gen.start({ kind: "overview" })), []); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => new Set((git.data?.files ?? []).map((f) => f.path)), [git.data]);
  const pages = o?.pages ?? [];
  const shown = useMemo(() => filterPages(pages, q), [pages, q]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  const sum = useMemo(() => summarize(pages, staleness), [pages, staleness]);
  const needWork = sum.stale + sum.drifting;
  const open = (p: PageInfo) => openTab({ kind: "doc", root, path: p.path, title: p.title });
  const toggle = (p: string) => setCollapsed((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set(s).add(p)));
  const empty = !!o && (!o.exists || pages.length === 0);

  const row = (p: PageInfo, depth: number) => (
    <PageRow key={p.path} page={p} st={staleness[p.path]} depth={depth} active={ws.activeTab === `doc:${root}:${p.path}`} dirty={dirty.has(p.path)} canAttach={!!ws.activeSession} onOpen={() => open(p)} onRefresh={() => gen.start({ kind: "refresh", page: p.path, locked: true })} onAttach={() => attach.attach.mutate({ path: p.path, mode: "ref" })} onCurrent={() => actions.markCurrent.mutate(p.path)} />
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-docs-sidebar>
      <div className="flex h-9 shrink-0 items-center gap-0.5 px-2">
        <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Docs</span>
        <IconButton label="Search the docs" size="icon-sm" aria-pressed={showSearch} onClick={() => setShowSearch((v) => !v)}>
          <Search />
        </IconButton>
        <IconButton label="New page" size="icon-sm" data-new-page onClick={() => setNewOpen("page")}>
          <FilePlus2 />
        </IconButton>
        <IconButton label="Write documentation…" size="icon-sm" data-generate onClick={() => gen.start({ kind: "overview" })}>
          <Sparkles />
        </IconButton>
        <IconButton label="Docs folder" size="icon-sm" onClick={() => setDirOpen(true)}>
          <Settings2 />
        </IconButton>
        <IconButton label="Refresh" size="icon-sm" onClick={() => void qc.invalidateQueries({ queryKey: docKey.root(root) })}>
          <RefreshCw className={cn(docs.isFetching && "animate-spin-fast")} />
        </IconButton>
      </div>

      {showSearch && (
        <div className="px-2 pb-1.5">
          <Input autoFocus data-docs-search value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a page or a phrase" className="h-7 text-[12.5px]" onKeyDown={(e) => e.key === "Escape" && (setQ(""), setShowSearch(false))} />
        </div>
      )}

      {docs.isPending ? (
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      ) : docs.error ? (
        <Empty icon={<BookText />} title="Could not read the docs" hint={(docs.error as Error).message} action={<Button size="sm" variant="outline" onClick={() => void docs.refetch()}>Try again</Button>} />
      ) : empty ? (
        <Empty
          icon={<BookText />}
          title={o?.exists ? "No pages yet" : "No docs folder yet"}
          hint={<>Documentation that lives in the repo, with a note of when each page was written, so you can see when it drifts. Nothing is created until you say so.</>}
          action={
            <div className="mt-1 flex flex-col gap-1.5">
              {!o?.exists && (
                <Button size="sm" variant="primary" data-create-folder onClick={() => actions.createFolder.mutate()} disabled={actions.createFolder.isPending}>
                  <FolderPlus /> Create {o?.dir ?? "docs"}/ folder
                </Button>
              )}
              <Button size="sm" variant={o?.exists ? "primary" : "outline"} data-generate-overview onClick={() => gen.start({ kind: "overview" })}>
                <Sparkles /> Generate overview
              </Button>
              <Button size="sm" variant="outline" onClick={() => setNewOpen("page")}>
                <FilePlus2 /> New page
              </Button>
            </div>
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          <LastRun root={root} />
          {needWork > 0 && (
            <div className="mx-2 mb-1.5 flex items-center gap-2 rounded-lg border border-amber/30 bg-amber/10 px-2.5 py-1.5" data-docs-drift>
              <AlertTriangle className="size-3.5 shrink-0 text-amber" />
              <div className="min-w-0 flex-1 text-[12px] leading-snug">
                {sum.stale > 0 && <span className="font-medium text-red">{sum.stale} stale</span>}
                {sum.stale > 0 && sum.drifting > 0 && ", "}
                {sum.drifting > 0 && <span className="font-medium text-amber">{sum.drifting} drifting</span>}
              </div>
              <Button size="xs" variant="outline" data-refresh-stale onClick={() => gen.start({ kind: "refresh", stale: true, locked: true })}>
                <Sparkles /> Refresh
              </Button>
            </div>
          )}
          {shown.length === 0 ? <p className="px-3 py-2 text-xs text-fg-muted">No page matches “{q}”.</p> : <FolderRows folder={tree} depth={0} collapsed={collapsed} toggle={toggle} row={row} />}
          {q.trim().length >= 3 && o && <TextHits root={root} dir={o.dir} q={q} onOpen={(path, line) => openTab({ kind: "file", root, path, title: path.replace(/^.*\//, ""), line })} />}
          <div className="mt-2 flex items-center gap-2 px-3 text-[10.5px] text-fg-faint">
            <span className="font-mono">{o?.dir}/</span>
            <span>· {pages.length} pages</span>
            {sum.fresh > 0 && <span>· {sum.fresh} up to date</span>}
            {sum.untracked > 0 && <span title="No commit or covers in the front matter">· {sum.untracked} not tracked</span>}
          </div>
        </div>
      )}

      <NewPageDialog
        open={newOpen !== null}
        onOpenChange={(v) => !v && setNewOpen(null)}
        docsDir={o?.dir ?? "docs"}
        nextAdr={o?.nextAdr ?? "0001"}
        initialKind={newOpen ?? "page"}
        busy={actions.createPage.isPending}
        onCreate={(a) =>
          actions.createPage.mutate(a, {
            onSuccess: (r) => {
              setNewOpen(null);
              openTab({ kind: "doc", root, path: r.path, title: r.title });
            },
          })
        }
      />
      <DocsDirDialog open={dirOpen} onOpenChange={setDirOpen} current={o?.dir ?? "docs"} custom={!!o?.custom} busy={actions.setDir.isPending} onSave={(d) => actions.setDir.mutate(d, { onSuccess: () => setDirOpen(false) })} />
      {gen.dialog}
    </div>
  );
}

function DocsDirDialog({ open, onOpenChange, current, custom, busy, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; current: string; custom: boolean; busy?: boolean; onSave: (dir: string | null) => void }) {
  const [v, setV] = useState(current);
  useEffect(() => void (open && setV(current)), [open, current]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={420}
      title="Docs folder"
      description="Where this project keeps its documentation, relative to the repository root. Changing it moves nothing."
      footer={
        <>
          {custom && (
            <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => onSave(null)}>
              Back to docs/
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !v.trim() || v.trim() === current} onClick={() => onSave(v.trim())}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Folder">
        <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} className="font-mono" spellCheck={false} onKeyDown={(e) => e.key === "Enter" && v.trim() && v.trim() !== current && onSave(v.trim())} />
      </Field>
    </Dialog>
  );
}
