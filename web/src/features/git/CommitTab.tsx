import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, GitCommitHorizontal, GitMerge, User } from "lucide-react";
import { get, url } from "@/lib/api";
import { parseDiff } from "@/lib/diff";
import { useRoot } from "@/lib/queries";
import { useUi, type Tab } from "@/lib/store";
import { ago, basename, cn, dirname } from "@/lib/utils";
import { gitToFsPath } from "@/lib/workspace";
import type { DiffResult, GitCommitDetail } from "@/lib/types";
import { Badge, Empty, SegTabs, Skeleton } from "@/components/ui/misc";
import { FileIcon } from "@/shell/FileIcon";
import { DiffFileView } from "./DiffBlocks";
import { gk } from "./queries";
import { useStored } from "./useStored";

type CommitTabData = Extract<Tab, { kind: "commit" }>;

const FILE_TONE: Record<string, "green" | "amber" | "red" | "violet"> = { A: "green", M: "amber", D: "red", R: "violet", C: "violet" };
const COLLAPSE_ABOVE = 20;

function CopySha({ sha }: { sha: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(sha);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      title="Copy full SHA"
      className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg-muted outline-none hover:text-fg"
    >
      {sha.slice(0, 10)}
      {done ? <Check className="size-3 animate-pop text-green" /> : <Copy className="size-3" />}
    </button>
  );
}

/** One commit: who, when, what it says, which files it touched, and every file's diff underneath. */
export function CommitTab({ tab }: { tab: CommitTabData }) {
  const root = tab.root;
  const openTab = useUi((s) => s.openTab);
  const rootInfo = useRoot(root);
  const prefix = rootInfo.data?.repo.prefix;
  const [mode, setMode] = useStored<"unified" | "split">("trb.git.diffMode", "unified");
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const detail = useQuery({ queryKey: gk.commit(root, tab.sha), queryFn: () => get<GitCommitDetail>(url.git(root, `commit/${tab.sha}`)), staleTime: 60_000 });
  const merge = (detail.data?.parents.length ?? 0) > 1;
  // `git show` prints a merge as a combined diff; the changes against the first parent are what a reader wants.
  const diffParams = merge ? { base: detail.data!.parents[0], head: tab.sha } : { commit: tab.sha };
  const diff = useQuery({ queryKey: gk.diff(root, diffParams), enabled: !!detail.data, queryFn: () => get<DiffResult>(url.git(root, "diff", diffParams)), staleTime: 60_000 });
  const files = useMemo(() => parseDiff(diff.data?.diff ?? ""), [diff.data?.diff]);

  const d = detail.data;
  const scrollTo = (path: string) => {
    setToggled((t) => ({ ...t, [path]: false }));
    // After the section expands.
    requestAnimationFrame(() => document.querySelector(`[data-commit-tab="${CSS.escape(tab.id)}"] [data-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  if (detail.isLoading)
    return (
      <div className="space-y-2 p-5">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40" />
      </div>
    );
  if (!d) return <Empty icon={<GitCommitHorizontal />} title="Commit not found" hint={(detail.error as Error | null)?.message} />;

  const totalAdd = files.reduce((n, f) => n + f.additions, 0);
  const totalDel = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div data-commit-tab={tab.id} className="h-full overflow-auto bg-panel">
      <div className="mx-auto max-w-[1100px] px-5 py-4">
        <header className="animate-slide-up border-b border-line pb-4">
          <h1 className="text-[17px] font-semibold leading-snug">{d.subject}</h1>
          {d.body && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-fg-muted">{d.body}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-fg-muted">
            <span className="flex items-center gap-1.5">
              <User className="size-3.5" />
              <span className="text-fg">{d.author}</span>
              <span className="text-fg-faint">{d.email}</span>
            </span>
            <span title={d.date}>{ago(d.date) === "now" ? "just now" : `${ago(d.date)} ago`} · {new Date(d.date).toLocaleString()}</span>
            <CopySha sha={d.sha} />
            {d.parents.map((p) => (
              <button key={p} onClick={() => openTab({ kind: "commit", root, sha: p, title: p.slice(0, 7) })} className="inline-flex items-center gap-1 rounded px-1 font-mono text-[11px] text-accent outline-none hover:underline">
                {merge && <GitMerge className="size-3" />}parent {p.slice(0, 7)}
              </button>
            ))}
            {d.parents.length === 0 && <Badge>root commit</Badge>}
          </div>
          {d.refs.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {d.refs.map((r) => (
                <Badge key={r} tone={r.startsWith("HEAD") ? "accent" : r.startsWith("tag:") ? "amber" : r.includes("/") ? "violet" : "green"}>
                  {r}
                </Badge>
              ))}
            </div>
          )}
        </header>

        <div className="mt-4 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            {d.files.length} file{d.files.length === 1 ? "" : "s"} changed {diff.data && <span className="ml-2 font-mono normal-case tracking-normal"><span className="text-green">+{totalAdd}</span> <span className="text-red">−{totalDel}</span></span>}
          </h2>
          <SegTabs value={mode} onChange={setMode} className="w-44" items={[{ value: "unified", label: "Unified" }, { value: "split", label: "Split" }]} />
        </div>
        {merge && <p className="mt-1 text-[11.5px] text-fg-faint">Merge commit: showing changes against its first parent.</p>}

        <ul className="mt-2 rounded-lg border border-line">
          {d.files.map((f, i) => (
            <li key={f.path} style={{ animationDelay: `${Math.min(i, 12) * 14}ms` }} className="animate-slide-up border-b border-line last:border-b-0">
              <button onClick={() => scrollTo(f.path)} className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-[12.5px] outline-none hover:bg-hover focus-visible:bg-hover">
                <Badge tone={FILE_TONE[f.status] ?? "neutral"} className="!w-4 justify-center !px-0">
                  {f.status}
                </Badge>
                <FileIcon name={f.path} className="size-3.5" />
                <span className="shrink-0">{basename(f.path)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-faint">{f.origPath ? `${f.origPath} → ` : ""}{dirname(f.path)}</span>
                {(() => {
                  const pf = files.find((x) => x.path === f.path);
                  return pf && !pf.binary ? (
                    <span className="shrink-0 font-mono text-[11px]">
                      <span className="text-green">+{pf.additions}</span> <span className="text-red">−{pf.deletions}</span>
                    </span>
                  ) : null;
                })()}
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-4">
          {diff.isLoading ? (
            <Skeleton className="h-48" />
          ) : diff.error ? (
            <div className="rounded-lg border border-red/30 bg-red/10 p-3 text-xs text-red">{(diff.error as Error).message}</div>
          ) : files.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line p-6 text-center text-xs text-fg-faint">This commit changes no files.</div>
          ) : (
            files.map((f) => {
              const size = f.hunks.reduce((n, h) => n + h.lines.length, 0);
              const collapsed = toggled[f.path] ?? (files.length > COLLAPSE_ABOVE || size > 1500);
              const fsPath = gitToFsPath(f.path, prefix);
              return (
                <DiffFileView
                  key={f.path}
                  file={f}
                  mode={mode}
                  collapsed={collapsed}
                  onToggle={() => setToggled((t) => ({ ...t, [f.path]: !collapsed }))}
                  stickyTop={0}
                  onOpenFile={fsPath === null || f.status === "deleted" ? undefined : (_p, line) => openTab({ kind: "file", root, path: fsPath, title: basename(fsPath), line })}
                />
              );
            })
          )}
          {diff.data?.truncated && <p className="text-xs text-amber">The diff was cut off at 1 MB.</p>}
        </div>
        <div className={cn("h-6")} />
      </div>
    </div>
  );
}

