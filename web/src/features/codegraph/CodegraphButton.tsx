import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, Network, RefreshCw, Terminal, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Popover } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Checkbox, Switch } from "@/components/ui/form";
import { useWorkspace } from "@/lib/workspace";
import { ago, cn } from "@/lib/utils";
import { compact, useCodegraphEstimate, useCodegraphJob, useCodegraphPrefs, useCodegraphState, type CodegraphJob, type CodegraphStatus } from "./data";
import { dotState, elapsed, sourceLabel, type DotState } from "./logic";

const VERB: Record<CodegraphJob["mode"], string> = { init: "Indexing", sync: "Syncing", reindex: "Re-indexing" };

const DOT: Record<DotState, string> = {
  none: "bg-fg-faint/60",
  indexed: "bg-green",
  stale: "bg-amber",
  incomplete: "bg-amber",
  failed: "bg-red",
  running: "",
  unavailable: "bg-fg-faint/40",
};

/**
 * The status bar's CodeGraph item: one label, one dot, one panel. Everything lives in the panel: the
 * state, the action that fits it, the live job, the two per-workspace switches and the install state.
 * Nothing here indexes on its own: every job starts from a click.
 */
export function CodegraphButton() {
  const { root } = useWorkspace();
  const state = useCodegraphState(root);
  const st = state.data?.codegraph;
  const jobs = useCodegraphJob(root);
  const [open, setOpen] = useState(false);
  const { job } = jobs;

  // A job that ends while the panel is closed still says so, once. A job that was already over when
  // the page loaded stays quiet.
  const watched = useRef<{ id: string; state: string } | null>(null);
  useEffect(() => {
    if (!job) return;
    const prev = watched.current;
    watched.current = { id: job.id, state: job.state };
    if (!prev || prev.id !== job.id || prev.state !== "running" || job.state === "running" || open) return;
    if (job.state === "done") toast.success(job.summary ?? "CodeGraph is up to date.");
    else if (job.state === "failed") toast.error(job.error ?? "CodeGraph failed.");
  }, [job?.id, job?.state]);

  if (!st) return null;
  const dot = dotState(st, job);
  const pct = job?.state === "running" ? job.progress.overall : null;

  return (
    <span className="flex h-full items-stretch">
      <Popover
        side="top"
        align="start"
        width={344}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button data-codegraph-button aria-haspopup="dialog" aria-label={`CodeGraph: ${dot}`} className="flex h-full items-center gap-1.5 px-2 outline-none transition-colors hover:bg-hover focus-visible:bg-hover">
            {dot === "running" ? (
              <Loader2 data-codegraph-dot data-state="running" className="size-3 animate-spin text-accent" />
            ) : (
              <span data-codegraph-dot data-state={dot} {...(dot === "stale" ? { "data-codegraph-stale": "" } : {})} className={cn("size-1.5 rounded-full transition-colors", DOT[dot], dot === "stale" && "animate-pop")} />
            )}
            <span>CodeGraph</span>
            {dot === "running" && pct !== null && <span className="font-mono text-fg-muted">{pct}%</span>}
            {dot === "stale" && st.pendingChanges > 0 && <span className="font-mono text-fg-faint">{st.pendingChanges}</span>}
          </button>
        }
      >
        <Panel root={root} st={st} jobs={jobs} open={open} />
      </Popover>
    </span>
  );
}

function Panel({ root, st, jobs, open }: { root: string; st: CodegraphStatus; jobs: ReturnType<typeof useCodegraphJob>; open: boolean }) {
  const prefs = useCodegraphPrefs(root);
  const { job, running } = jobs;
  const [gitignore, setGitignore] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const estimate = useCodegraphEstimate(root, open && st.state === "none" && st.available);
  const initialized = st.state === "indexed" || st.state === "stale" || st.state === "incomplete";

  if (!st.available) return <InstallPanel st={st} />;

  return (
    <div data-codegraph-panel className="grid gap-2.5 p-1.5 font-sans text-[12px]">
      <Header st={st} job={job} />

      {st.note && !running && (
        <p data-codegraph-note className={cn("flex gap-1.5 rounded-md border px-2 py-1.5 leading-relaxed", st.state === "incomplete" ? "border-amber/40 text-amber" : "border-line text-fg-muted")}>
          {st.state === "incomplete" && <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
          <span>{st.note}</span>
        </p>
      )}
      {st.reindexRecommended && !running && st.state !== "incomplete" && (
        <p data-codegraph-reindex-note className="rounded-md border border-amber/40 px-2 py-1.5 leading-relaxed text-amber">
          This index was built by CodeGraph {st.builtWith ?? "an older version"}. Sync cannot refresh it: a full re-index brings it up to date with {st.version ? `v${st.version}` : "this version"}.
        </p>
      )}

      {job && <JobArea job={job} jobs={jobs} />}
      {jobs.error && !job && (
        <p data-codegraph-error className="flex gap-1.5 rounded-md border border-red/40 px-2 py-1.5 leading-relaxed text-red">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{jobs.error}</span>
        </p>
      )}

      {st.state === "none" && !running && (
        <div className="grid gap-2">
          <p className="leading-relaxed text-fg-muted">
            Builds a searchable map of this project's code so agents can look things up instead of grepping. It creates a <code className="font-mono text-fg">.codegraph/</code> folder in the repo and indexes your source files once. Nothing is sent anywhere.
          </p>
          <div data-codegraph-estimate className="rounded-md border border-line px-2.5 py-1.5 text-fg-muted">
            {estimate.data ? (
              <>
                About <span className="font-mono text-fg">{estimate.data.capped ? "more than " : ""}{estimate.data.files.toLocaleString("en-US")}</span> source files to index.
              </>
            ) : estimate.isError ? (
              "Could not count the files."
            ) : (
              "Counting files…"
            )}
          </div>
          {estimate.data?.warning && (
            <p data-codegraph-warning className="flex gap-1.5 rounded-md border border-amber/40 px-2 py-1.5 leading-relaxed text-amber">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>{estimate.data.warning}</span>
            </p>
          )}
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line px-2.5 py-2">
            <Checkbox checked={gitignore} onChange={setGitignore} label="Add .codegraph/ to .gitignore" />
            <span>
              <span className="block font-medium">
                Add <code className="font-mono">.codegraph/</code> to .gitignore
              </span>
              <span className="block text-fg-muted">Appended only if it is not already ignored. Nothing else in the file changes.</span>
            </span>
          </label>
        </div>
      )}

      {!running && <Actions st={st} jobs={jobs} gitignore={gitignore} />}

      {initialized && !running && (
        <div className="grid gap-1.5 border-t border-line pt-2">
          <div className="flex gap-1.5">
            {st.state !== "incomplete" && !st.reindexRecommended && (
              <Button data-codegraph-reindex size="sm" variant="subtle" className="flex-1" onClick={() => jobs.start.mutate({ mode: "reindex" })}>
                <RefreshCw /> Re-index (full)
              </Button>
            )}
            {!confirmRemove && (
              <Button data-codegraph-uninit size="sm" variant="dangerGhost" className="flex-1" onClick={() => setConfirmRemove(true)}>
                <Trash2 /> Remove index…
              </Button>
            )}
          </div>
          {confirmRemove && (
            <div data-codegraph-uninit-confirm className="grid gap-1.5 rounded-md border border-red/40 p-2">
              <span className="leading-relaxed">
                Delete <code className="font-mono">.codegraph/</code> from this project? Agents lose the index until you initialize again. Your code is not touched.
              </span>
              <div className="flex justify-end gap-1.5">
                <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(false)}>
                  Keep it
                </Button>
                <Button data-codegraph-uninit-yes size="xs" variant="danger" disabled={jobs.uninit.isPending} onClick={() => jobs.uninit.mutate(undefined, { onSettled: () => setConfirmRemove(false) })}>
                  Remove index
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-1.5 border-t border-line pt-2">
        <Row title="Use in sessions" hint="Agents get codegraph_explore and codegraph_node in this project.">
          <Switch checked={st.setting === "auto"} onChange={(v) => prefs.mutate({ use: v })} label="Use CodeGraph in sessions" />
        </Row>
        {st.useOverride && (
          <button className="-mt-0.5 justify-self-start px-1 text-[11px] text-fg-faint underline-offset-2 outline-none hover:text-fg hover:underline" onClick={() => prefs.mutate({ use: null })}>
            Follow the global setting instead
          </button>
        )}
        <Row title="Keep in sync after turns" hint="After a turn that changed files, update the index in the background.">
          <Switch checked={st.keepInSync} onChange={(v) => prefs.mutate({ keepInSync: v })} label="Keep the CodeGraph index in sync after turns" />
        </Row>
      </div>
    </div>
  );
}

function Header({ st, job }: { st: CodegraphStatus; job: CodegraphJob | null }) {
  const label = job?.state === "running" ? VERB[job.mode] : { none: "Not initialized", indexed: "Indexed", stale: st.reindexRecommended && st.pendingChanges === 0 ? "Re-index recommended" : "Stale", incomplete: "Incomplete", unavailable: "Unavailable" }[st.state];
  const tone = job?.state === "running" ? "text-accent" : st.state === "indexed" ? "text-green" : st.state === "stale" || st.state === "incomplete" ? "text-amber" : "text-fg-muted";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">CodeGraph</span>
        <span data-codegraph-state className={cn("font-medium", tone)}>
          {label}
        </span>
      </div>
      <div data-codegraph-source className="mt-0.5 font-mono text-[11px] text-fg-faint">
        {sourceLabel(st)}
      </div>
      {(st.state === "indexed" || st.state === "stale" || st.state === "incomplete") && (
        <p className="mt-1 leading-relaxed text-fg-muted" data-codegraph-counts>
          {compact(st.symbols)} symbols, {compact(st.files)} files, {compact(st.edges)} edges.
          {st.lastIndexed ? ` Last indexed ${ago(st.lastIndexed)}${ago(st.lastIndexed) === "now" ? "" : " ago"}.` : ""}
          {st.pendingChanges > 0 && st.state !== "incomplete" ? ` ${st.pendingChanges} change${st.pendingChanges === 1 ? "" : "s"} pending.` : ""}
        </p>
      )}
    </div>
  );
}

function Actions({ st, jobs, gitignore }: { st: CodegraphStatus; jobs: ReturnType<typeof useCodegraphJob>; gitignore: boolean }) {
  const go = (mode: "init" | "sync" | "reindex") => jobs.start.mutate({ mode, gitignore });
  if (st.state === "none")
    return (
      <Button data-codegraph-primary data-codegraph-init size="sm" variant="primary" autoFocus disabled={jobs.start.isPending} onClick={() => go("init")}>
        <Network /> Initialize and index
      </Button>
    );
  if (st.state === "incomplete")
    return (
      <Button data-codegraph-primary data-codegraph-resume size="sm" variant="primary" autoFocus disabled={jobs.start.isPending} onClick={() => go("reindex")}>
        <RefreshCw /> Resume: re-index
      </Button>
    );
  if (st.reindexRecommended)
    return (
      <Button data-codegraph-primary data-codegraph-reindex-primary size="sm" variant="primary" autoFocus disabled={jobs.start.isPending} onClick={() => go("reindex")}>
        <RefreshCw /> Re-index
      </Button>
    );
  return (
    <Button data-codegraph-primary data-codegraph-sync size="sm" variant="primary" autoFocus disabled={jobs.start.isPending} onClick={() => go("sync")}>
      <RefreshCw /> {st.pendingChanges > 0 ? `Sync (${st.pendingChanges} change${st.pendingChanges === 1 ? "" : "s"})` : "Sync"}
    </Button>
  );
}

/** The live job: progress while it runs, then the result (or the real error) until dismissed. */
function JobArea({ job, jobs }: { job: CodegraphJob; jobs: ReturnType<typeof useCodegraphJob> }) {
  const [copied, setCopied] = useState(false);
  const now = useNow(job.state === "running");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([job.error, ...job.log].filter(Boolean).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };
  if (job.state === "running") {
    const p = job.progress;
    const determinate = p.overall !== null;
    return (
      <div data-codegraph-job data-state="running" className="grid gap-1.5 rounded-md border border-line bg-bg/60 p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-medium">
            {VERB[job.mode]}
            <span className="font-normal text-fg-muted">
              {p.phase ? `: ${p.phase}${p.percent !== null ? ` ${p.percent}%` : ""}${p.detail ? `, ${p.detail}` : ""}` : ": starting…"}
            </span>
          </span>
          <span data-codegraph-elapsed className="shrink-0 font-mono text-[11px] text-fg-faint">
            {elapsed(job.startedAt, now)}
          </span>
        </div>
        <div role="progressbar" aria-label="CodeGraph progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={determinate ? p.overall! : undefined} data-codegraph-progress className={cn("relative h-1.5 overflow-hidden rounded-full bg-active", !determinate && "sweep")}>
          {determinate && <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${p.overall}%` }} />}
        </div>
        {job.log.length > 0 && (
          <pre data-codegraph-log className="max-h-14 overflow-hidden whitespace-pre-wrap font-mono text-[10.5px] leading-snug text-fg-faint">
            {job.log.slice(-3).join("\n")}
          </pre>
        )}
        <div className="flex justify-end">
          <Button data-codegraph-cancel size="xs" variant="ghost" disabled={jobs.cancel.isPending} onClick={() => jobs.cancel.mutate()}>
            <X /> {jobs.cancel.isPending ? "Cancelling…" : "Cancel"}
          </Button>
        </div>
      </div>
    );
  }
  const ok = job.state === "done";
  const failed = job.state === "failed";
  return (
    <div data-codegraph-job data-state={job.state} className={cn("grid gap-1.5 rounded-md border p-2 animate-slide-up", ok ? "border-green/40" : failed ? "border-red/40" : "border-line")}>
      <div className="flex items-start gap-1.5">
        {ok ? <Check className="mt-0.5 size-3 shrink-0 text-green" strokeWidth={3} /> : failed ? <AlertTriangle className="mt-0.5 size-3 shrink-0 text-red" /> : <X className="mt-0.5 size-3 shrink-0 text-fg-faint" />}
        <div className="min-w-0 flex-1 leading-relaxed">
          {ok && (
            <div data-codegraph-result className="font-medium">
              {job.summary ?? "Done."}
            </div>
          )}
          {failed && (
            <div data-codegraph-error className="break-words text-red">
              {job.error ?? "CodeGraph failed."}
            </div>
          )}
          {job.state === "cancelled" && <div className="font-medium">Cancelled.</div>}
          {job.note && <div className="text-fg-muted">{job.note}</div>}
        </div>
      </div>
      <div className="flex justify-end gap-1.5">
        {(failed || job.log.length > 0) && (
          <Button data-codegraph-copylog size="xs" variant="ghost" onClick={copy}>
            {copied ? <Check className="text-green" /> : <Copy />} {copied ? "Copied" : "Copy log"}
          </Button>
        )}
        <Button data-codegraph-dismiss size="xs" variant="ghost" onClick={() => jobs.dismiss.mutate()}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border border-line px-2.5 py-2">
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-fg-muted">{hint}</span>
      </span>
      {children}
    </label>
  );
}

function InstallPanel({ st }: { st: CodegraphStatus }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(st.installCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };
  return (
    <div data-codegraph-panel className="grid gap-2.5 p-1.5 font-sans text-[12px]">
      <div>
        <div className="font-semibold">CodeGraph is not available</div>
        <p className="mt-0.5 leading-relaxed text-fg-muted">
          The copy that ships with this app is missing for this platform, and there is no <code className="font-mono">codegraph</code> on PATH. Run this in a terminal, then open a new one so the command resolves. This app never runs it for you.
        </p>
        {st.note && <p className="mt-1 leading-relaxed text-amber">{st.note}</p>}
      </div>
      <div className="flex items-start gap-2 rounded-md border border-line bg-bg p-2">
        <Terminal className="mt-0.5 size-3 shrink-0 text-fg-faint" />
        <code data-codegraph-install className="min-w-0 flex-1 break-all font-mono text-[11px] text-fg">
          {st.installCommand}
        </code>
      </div>
      <Button size="sm" variant="subtle" onClick={copy}>
        {copied ? <Check className="text-green" /> : <Copy />} {copied ? "Copied" : "Copy command"}
      </Button>
    </div>
  );
}
