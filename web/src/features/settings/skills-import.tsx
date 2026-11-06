/**
 * Importing skills: pick a folder, see what is in it, choose, and watch the copy.
 *
 * Three steps in one dialog. The last one is why this exists: copying a folder of skills can take a while, and a
 * button that says "Importing…" and nothing else looks hung. Here the daemon runs the copy as a job and reports
 * which skill it is on, how many of its files are done, and which skills finished and how; the bar moves
 * forward only, and if nothing has moved for a few seconds it says what it is waiting on. Closing the dialog does
 * not stop the job; the Skills page header keeps showing it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUp, Check, ChevronRight, Copy, FileDown, Folder, FolderOpen, Home as HomeIcon, Loader2, MinusCircle, RefreshCw, Search, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog, Tooltip } from "@/components/ui/overlay";
import { Checkbox, Input, Switch } from "@/components/ui/form";
import { Badge, Empty, Spinner } from "@/components/ui/misc";
import { confirm } from "@/components/ui/dialogs";
import { cn } from "@/lib/utils";
import { ErrorNote, WarnNote } from "./shared";
import { keys } from "./data";
import { skillsApi } from "./skills-api";
import { lastImportDir, rememberImportDir, useSkillImport, type ImportMode } from "./skills-state";
import {
  currentLabel,
  currentPercent,
  filterSkills,
  formatBytes,
  formatElapsed,
  formatEta,
  formatReport,
  initialSelection,
  isStalled,
  looksLikeSkillsFolder,
  monotonic,
  overallPercent,
  plural,
  pulseChanged,
  pulseOf,
  reconcileSelection,
  scanSummary,
  selectable,
  selectedSummary,
  selectionState,
  setAll,
  skillFlags,
  summarizeResults,
  countResults,
  type ImportItem,
  type ImportJobState,
  type Pulse,
  type ScanResult,
} from "./skills-logic";

/* -------------------------------------------------------------------------- */
/* Small pieces                                                               */
/* -------------------------------------------------------------------------- */

export function ProgressBar({ percent, className, running = false, tone = "accent" }: { percent: number; className?: string; running?: boolean; tone?: "accent" | "green" | "red" | "amber" }) {
  const fill = { accent: "bg-accent", green: "bg-green", red: "bg-red", amber: "bg-amber" }[tone];
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} className={cn("h-1.5 w-full overflow-hidden rounded-full bg-active", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-200 ease-out", fill, running && "sweep")} style={{ width: `${Math.max(percent > 0 ? 2 : 0, percent)}%` }} />
    </div>
  );
}

/** A clock that ticks, so elapsed time and stall detection move even when the daemon says nothing new. */
function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, active]);
  return now;
}

/** The job being watched, polled every quarter second while it runs. */
export function useImportJob(jobId: string | null) {
  return useQuery({
    queryKey: ["skills", "import-job", jobId],
    enabled: !!jobId,
    queryFn: () => skillsApi.job(jobId!),
    refetchInterval: (q) => (q.state.data?.status === "running" || !q.state.data ? 250 : false),
    refetchIntervalInBackground: true,
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Starting a job                                                             */
/* -------------------------------------------------------------------------- */

async function begin(dir: string, picked: Array<{ name: string; bytes: number }> | null, overwrite: boolean): Promise<void> {
  const { job } = await skillsApi.start(dir, picked ? picked.map((p) => p.name) : null, overwrite);
  rememberImportDir(dir);
  useSkillImport.getState().openJob(job.id, Object.fromEntries((picked ?? []).map((p) => [p.name, p.bytes])));
}

/** Re-copy one stored skill from the folder it was imported from. Throws a readable error when that folder is gone. */
export async function startReimport(name: string, source: string): Promise<void> {
  const scan = await skillsApi.scan(source);
  const found = scan.skills.find((s) => s.name === name);
  if (!found) throw new Error(`${source} no longer contains a skill named ${name}.`);
  await begin(scan.root, [{ name, bytes: found.bytes }], true);
}

/* -------------------------------------------------------------------------- */
/* Step 1: pick a folder                                                      */
/* -------------------------------------------------------------------------- */

function FolderBrowser({ value, onChange, onActivate }: { value: string; onChange: (p: string) => void; onActivate: () => void }) {
  const [typed, setTyped] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["skills", "browse", value], queryFn: () => skillsApi.browse(value), retry: false, placeholderData: (p) => p, staleTime: 10_000 });
  const here = q.data?.path ?? value;
  const hint = looksLikeSkillsFolder(here.split("/").filter(Boolean).pop() ?? "");
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-1.5 border-b border-line p-2">
        <IconButton label="Up one folder" size="icon-sm" disabled={!q.data?.parent} onClick={() => q.data?.parent && onChange(q.data.parent)}>
          <ArrowUp />
        </IconButton>
        <IconButton label="Home folder" size="icon-sm" onClick={() => onChange(q.data?.home ?? "~")}>
          <HomeIcon />
        </IconButton>
        <Input
          className="h-7 font-mono text-xs"
          aria-label="Folder"
          spellCheck={false}
          value={typed ?? here}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (typed !== null) {
                onChange(typed);
                setTyped(null);
              } else onActivate();
            }
          }}
          onBlur={() => typed !== null && (onChange(typed), setTyped(null))}
        />
      </div>
      <div className="h-[230px] overflow-y-auto p-1" aria-label="Subfolders">
        {q.isLoading && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
        {q.error && <div className="p-3"><ErrorNote>{(q.error as Error).message}</ErrorNote></div>}
        {q.data?.entries.map((e) => (
          <button key={e.path} onClick={() => onChange(e.path)} className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover">
            {e.repo ? <Folder className="size-4 shrink-0 text-accent" /> : <Folder className="size-4 shrink-0 text-fg-faint" />}
            <span className="flex-1 truncate">{e.name}</span>
            {looksLikeSkillsFolder(e.name) && <Badge tone="accent">skills?</Badge>}
            <ChevronRight className="size-3.5 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
        {q.data && q.data.entries.length === 0 && <div className="p-4 text-center text-xs text-fg-faint">No subfolders here.</div>}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[11.5px]">
        <FolderOpen className="size-3.5 shrink-0 text-fg-faint" />
        <span className={cn("min-w-0 flex-1 truncate font-mono", hint ? "text-accent" : "text-fg-faint")} title={here}>
          {here}
        </span>
        {hint && <span className="shrink-0 text-accent">looks like a skills folder</span>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 2: the scan                                                           */
/* -------------------------------------------------------------------------- */

function ScanList({ scan, selected, setSelected, overwrite, onOverwrite, mode }: { scan: ScanResult; selected: Set<string>; setSelected: (s: Set<string>) => void; overwrite: boolean; onOverwrite: (v: boolean) => void; mode: ImportMode }) {
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => filterSkills(scan.skills, filter), [scan.skills, filter]);
  const state = selectionState(selected, visible, overwrite);
  const existing = scan.skills.filter((s) => s.exists).length;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="text-[13px] font-medium">{scanSummary(scan)}</div>
        <div className="font-mono text-[11px] text-fg-faint" title={scan.root}>
          in {scan.root.replace(/^\/Users\/[^/]+/, "~")}
        </div>
      </div>
      {scan.truncated && <WarnNote>This folder holds more skills than are listed here. Import a more specific folder to see the rest.</WarnNote>}
      {scan.duplicates.length > 0 && (
        <WarnNote>
          {plural(scan.duplicates.length, "folder")} {scan.duplicates.length === 1 ? "shares" : "share"} a name with a skill listed here and {scan.duplicates.length === 1 ? "was" : "were"} ignored: <span className="font-mono">{scan.duplicates.slice(0, 3).join(", ")}</span>
          {scan.duplicates.length > 3 ? ", …" : ""}
        </WarnNote>
      )}
      <div className="flex items-center gap-2">
        {scan.skills.length > 4 && (
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, description or folder" className="h-7 pl-8 text-xs" aria-label="Filter skills" />
          </div>
        )}
        <label className="ml-auto flex shrink-0 items-center gap-2 text-xs text-fg-muted">
          <Switch checked={overwrite} onChange={onOverwrite} label="Replace skills that already exist" />
          {mode === "single" ? "Replace if it already exists" : `Replace existing${existing ? ` (${existing})` : ""}`}
        </label>
      </div>
      <div className="overflow-hidden rounded-lg border border-line">
        {scan.skills.length > 1 && (
          <div className="flex h-8 items-center gap-2.5 border-b border-line bg-raised/60 px-3 text-xs text-fg-muted">
            <Checkbox checked={state === "all" ? true : state === "some" ? "indeterminate" : false} onChange={(on) => setSelected(setAll(selected, visible, overwrite, on))} label="Select all" />
            <span>
              {selected.size} of {scan.skills.length} selected{filter ? ` · showing ${visible.length}` : ""}
            </span>
          </div>
        )}
        <ul className="max-h-[300px] overflow-y-auto" aria-label="Skills found">
          {visible.map((s) => {
            const can = selectable(s, overwrite);
            const on = selected.has(s.name);
            return (
              <li key={s.name} className={cn("flex items-start gap-2.5 border-b border-line px-3 py-2 last:border-b-0", !can && "opacity-60")}>
                <Checkbox
                  className="mt-0.5"
                  checked={on}
                  onChange={(v) => {
                    const next = new Set(selected);
                    if (v) next.add(s.name);
                    else next.delete(s.name);
                    setSelected(next);
                  }}
                  label={`Import ${s.name}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[12.5px] font-medium">{s.name}</span>
                    {s.relDir !== "." && <span className="truncate font-mono text-[10.5px] text-fg-faint">{s.relDir}</span>}
                  </div>
                  {s.description && <div className="mt-0.5 line-clamp-1 text-[11.5px] text-fg-muted">{s.description}</div>}
                  {s.error && <div className="mt-1 text-[11.5px] text-red">{s.error}</div>}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  {skillFlags(s).map((f) => (
                    <Tooltip key={f.kind} label={<span className="whitespace-pre-wrap">{f.title ?? f.label}</span>}>
                      <span>
                        <Badge tone={f.kind === "fail" ? "red" : f.kind === "exists" ? "amber" : "neutral"}>{f.label}</Badge>
                      </span>
                    </Tooltip>
                  ))}
                  <Badge>
                    {plural(s.files, "file")} · {formatBytes(s.bytes)}
                  </Badge>
                </div>
              </li>
            );
          })}
          {visible.length === 0 && <li className="p-4 text-center text-xs text-fg-faint">No skill matches “{filter}”.</li>}
        </ul>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 3: progress                                                           */
/* -------------------------------------------------------------------------- */

const STATUS_STYLE: Record<ImportItem["status"], { icon: React.ReactNode; tone: string; label: string }> = {
  added: { icon: <Check className="size-3.5" />, tone: "text-green", label: "added" },
  replaced: { icon: <RefreshCw className="size-3.5" />, tone: "text-blue", label: "replaced" },
  skipped: { icon: <MinusCircle className="size-3.5" />, tone: "text-fg-faint", label: "skipped" },
  failed: { icon: <XCircle className="size-3.5" />, tone: "text-red", label: "failed" },
};

function ResultRow({ r }: { r: ImportItem }) {
  const st = STATUS_STYLE[r.status];
  return (
    <li className="animate-slide-up flex items-start gap-2.5 border-b border-line px-3 py-1.5 last:border-b-0" data-status={r.status}>
      <span className={cn("mt-0.5 shrink-0", st.tone)} aria-label={st.label}>
        {st.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px]">{r.name}</div>
        {r.reason && <div className={cn("text-[11.5px] leading-snug", r.status === "failed" ? "text-red" : "text-fg-muted")}>{r.reason}</div>}
      </div>
      <span className="shrink-0 font-mono text-[10.5px] text-fg-faint">
        {plural(r.files, "file")} · {formatBytes(r.bytes)}
      </span>
    </li>
  );
}

function ProgressView({ job, sizes }: { job: ImportJobState; sizes: Record<string, number> }) {
  const running = job.status === "running";
  const now = useNow(500, running);
  const pulse = useRef<{ p: Pulse | null; at: number }>({ p: null, at: Date.now() });
  const peak = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const stick = useRef(true);

  const p = pulseOf(job);
  if (pulseChanged(pulse.current.p, p)) pulse.current = { p, at: Date.now() };

  const raw = overallPercent(job, job.current ? (sizes[job.current.name] ?? 0) : 0);
  peak.current = monotonic(peak.current, raw);
  const percent = job.status === "done" ? 100 : peak.current;
  const startedAt = Date.parse(job.startedAt);
  const elapsed = (job.finishedAt ? Date.parse(job.finishedAt) : now) - startedAt;
  const eta = running ? formatEta(elapsed, percent) : null;
  const stalled = isStalled(job.status, pulse.current.at, now);
  const counts = countResults(job.results);

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [job.results.length]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[12.5px]">
          <span className="font-medium">
            {running ? "Importing skills" : job.status === "cancelled" ? "Import cancelled" : counts.failed ? "Import finished with problems" : "Import finished"}
          </span>
          <span className="font-mono text-[11.5px] text-fg-muted">
            {job.done} of {job.total} skills · {formatBytes(job.doneBytes)} / {formatBytes(job.totalBytes)} · {percent}%
          </span>
        </div>
        <ProgressBar percent={percent} running={running} tone={job.status === "cancelled" ? "amber" : counts.failed && !running ? "amber" : job.status === "done" ? "green" : "accent"} className="h-2" />
        <div className="mt-1.5 flex items-center justify-between font-mono text-[10.5px] text-fg-faint">
          <span>{formatElapsed(elapsed)} elapsed</span>
          <span>{eta ?? (running ? "estimating…" : "")}</span>
        </div>
      </div>

      {running && job.current && (
        <div className="rounded-lg border border-line bg-raised/50 px-3 py-2.5 animate-slide-up" aria-live="polite">
          <div className="mb-1.5 flex items-center gap-2 text-[12.5px]">
            <Loader2 className="size-3.5 shrink-0 animate-spin-fast text-accent" />
            <span className="min-w-0 flex-1 truncate">{currentLabel(job)}</span>
            <span className="shrink-0 font-mono text-[11px] text-fg-muted">{currentPercent(job)}%</span>
          </div>
          <ProgressBar percent={currentPercent(job)} running className="h-1" />
          {stalled && (
            <div className="mt-1.5 text-[11.5px] text-fg-muted">
              Still working on <span className="font-mono">{job.current.name}</span>: {job.current.filesDone} of {plural(job.current.filesTotal, "file")} copied. Large files take a moment.
            </div>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line">
        <div className="flex h-7 items-center justify-between border-b border-line bg-raised/60 px-3 text-[11px] text-fg-muted">
          <span>Results</span>
          <span className="font-mono">
            <span className="text-green">{counts.added + counts.replaced} imported</span>
            {counts.skipped > 0 && <span> · {counts.skipped} skipped</span>}
            {counts.failed > 0 && <span className="text-red"> · {counts.failed} failed</span>}
          </span>
        </div>
        <ul
          ref={list}
          aria-label="Import results"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="h-[190px] overflow-y-auto"
        >
          {job.results.length === 0 && <li className="flex h-full items-center justify-center p-4 text-xs text-fg-faint">Skills appear here as each one is copied.</li>}
          {job.results.map((r) => (
            <ResultRow key={r.name} r={r} />
          ))}
        </ul>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The dialog                                                                 */
/* -------------------------------------------------------------------------- */

const DEFAULT_DIR = "~/.claude/skills";

export function ImportDialog({ onFinished }: { onFinished?: () => void }) {
  const { open, mode, jobId, sizes, close, dismiss, markSeen } = useSkillImport();
  const qc = useQueryClient();
  const jobQ = useImportJob(jobId);
  const job = jobQ.data ?? null;

  const [dir, setDir] = useState(DEFAULT_DIR);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [starting, setStarting] = useState(false);

  // A fresh dialog (no job in flight) starts at the last folder used, back at step one.
  useEffect(() => {
    if (open && !jobId) {
      setDir(lastImportDir() ?? (mode === "single" ? "~" : DEFAULT_DIR));
      setScan(null);
      setError(null);
      setOverwrite(false);
      setSelected(new Set());
    }
  }, [open, jobId, mode]);

  // Opening the dialog on a finished job counts as seeing it.
  useEffect(() => {
    if (open && job && job.status !== "running") markSeen();
  }, [open, job?.status, markSeen]); // eslint-disable-line react-hooks/exhaustive-deps

  const doScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const r = await skillsApi.scan(dir.trim());
      setScan(r);
      setOverwrite(false);
      setSelected(initialSelection(r.skills, false));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setScanning(false);
    }
  };

  const changeOverwrite = (v: boolean) => {
    setOverwrite(v);
    if (scan) setSelected((prev) => reconcileSelection(prev, scan.skills, v));
  };

  const start = async () => {
    if (!scan) return;
    setStarting(true);
    setError(null);
    try {
      const picked = scan.skills.filter((s) => selected.has(s.name)).map((s) => ({ name: s.name, bytes: s.bytes }));
      await begin(scan.root, picked, overwrite);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setStarting(false);
    }
  };

  const cancelJob = async () => {
    if (!jobId) return;
    const ok = await confirm({
      title: "Cancel this import?",
      description: "The skill being copied right now is discarded. Skills that already finished stay imported.",
      confirmLabel: "Cancel import",
      danger: true,
    });
    if (ok) await skillsApi.cancel(jobId).catch((e) => toast.error(e.message));
  };

  const finish = () => {
    if (job) {
      const msg = summarizeResults(job.results, job.status === "cancelled");
      (countResults(job.results).failed ? toast.warning : toast.success)(msg);
    }
    qc.invalidateQueries({ queryKey: keys.skills });
    dismiss();
    onFinished?.();
  };

  const running = job?.status === "running";
  const picked = scan ? selectedSummary(scan, selected) : null;
  const single = mode === "single";

  /* ---- which step ---- */
  let title: string;
  let description: string;
  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (jobId) {
    title = running ? "Importing skills" : job?.status === "cancelled" ? "Import cancelled" : "Import finished";
    description = running ? "You can close this window: the import keeps going in the background, and the Skills page shows its progress." : job ? summarizeResults(job.results, job.status === "cancelled") : "";
    if (jobQ.isError) {
      body = <ErrorNote>This import is no longer tracked (the daemon was restarted). Skills copied before that are kept. {(jobQ.error as Error).message}</ErrorNote>;
      footer = <Button variant="primary" onClick={finish}>Done</Button>;
    } else if (!job) {
      body = (
        <div className="flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      );
      footer = null;
    } else {
      body = <ProgressView job={job} sizes={sizes} />;
      footer = running ? (
        <>
          <Button variant="ghost" onClick={close}>
            Hide
          </Button>
          <Button variant="dangerGhost" onClick={cancelJob}>
            Cancel import
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(formatReport(job)).then(() => toast.success("Report copied"))}>
            <Copy /> Copy report
          </Button>
          <Button variant="primary" onClick={finish}>
            Done
          </Button>
        </>
      );
    }
  } else if (scan) {
    title = single ? "Add a skill from a folder" : "Import skills";
    description = single ? "The folder is copied into trb's own store, with every file in it, so the original can move or go away." : "Choose what to import. Each skill is copied with all of its files (scripts, references, templates).";
    body = scan.skills.length === 0 ? (
      <Empty icon={<FileDown />} title="No skills in this folder" hint="A skill is a folder with a SKILL.md in it. Pick the folder that contains them." className="py-8" />
    ) : (
      <ScanList scan={scan} selected={selected} setSelected={setSelected} overwrite={overwrite} onOverwrite={changeOverwrite} mode={mode} />
    );
    footer = (
      <>
        {error && <span className="mr-auto max-w-[50%] truncate text-xs text-red">{error}</span>}
        <Button variant="ghost" onClick={() => setScan(null)}>
          Back
        </Button>
        <Button variant="primary" onClick={start} disabled={starting || !picked || picked.count === 0}>
          {starting ? "Starting…" : picked && picked.count > 0 ? (single ? "Add skill" : `Import ${plural(picked.count, "skill")}`) : "Nothing selected"}
        </Button>
      </>
    );
  } else {
    title = single ? "Add a skill from a folder" : "Import skills from a folder";
    description = single ? "Pick the folder of the skill (the one with a SKILL.md in it)." : "Pick a folder. Skills can be nested at any depth: every folder with a SKILL.md is found.";
    body = (
      <div className="flex flex-col gap-2.5">
        <FolderBrowser value={dir} onChange={(p) => (setDir(p), setError(null))} onActivate={doScan} />
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" onClick={doScan} disabled={scanning || !dir.trim()}>
          {scanning ? (
            <>
              <Spinner className="text-current" /> Scanning…
            </>
          ) : (
            "Scan this folder"
          )}
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title={title} description={description} width={jobId || scan ? 680 : 560} footer={footer}>
      {body}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* The Skills page header indicator                                           */
/* -------------------------------------------------------------------------- */

/** A small pill that shows an import in flight (or just finished) while the dialog is closed, and reopens it. */
export function ImportIndicator() {
  const { jobId, open, sizes, unseen, openDialog, dismiss, markUnseen } = useSkillImport();
  const qc = useQueryClient();
  const job = useImportJob(jobId).data ?? null;
  const peak = useRef({ id: "", v: 0 });
  const announced = useRef<string | null>(null);

  // A job that ends while nobody is looking: refresh the list and say so once.
  useEffect(() => {
    if (!job || job.status === "running" || announced.current === job.id) return;
    announced.current = job.id;
    qc.invalidateQueries({ queryKey: keys.skills });
    if (!open) {
      markUnseen();
      (countResults(job.results).failed ? toast.warning : toast.success)(summarizeResults(job.results, job.status === "cancelled"));
    }
  }, [job, open, qc, markUnseen]);

  // Skills appear in the list as they land, not only at the end.
  const done = job?.done ?? 0;
  useEffect(() => {
    if (done > 0) qc.invalidateQueries({ queryKey: keys.skills });
  }, [done, qc]);

  if (!jobId || !job || open) return null;
  if (peak.current.id !== job.id) peak.current = { id: job.id, v: 0 };
  const pct = job.status === "running" ? monotonic(peak.current.v, overallPercent(job, job.current ? (sizes[job.current.name] ?? 0) : 0)) : 100;
  peak.current.v = pct;

  if (job.status === "running") {
    return (
      <button onClick={() => openDialog("directory")} title="Show import progress" className="animate-slide-up flex h-7 items-center gap-2 rounded-md border border-accent/30 bg-accent-soft px-2.5 text-xs text-accent outline-none transition-colors hover:border-accent/60">
        <Loader2 className="size-3.5 animate-spin-fast" />
        <span className="font-mono">
          Importing {job.done}/{job.total}
        </span>
        <span className="w-14">
          <ProgressBar percent={pct} className="h-1" />
        </span>
        <span className="font-mono">{pct}%</span>
      </button>
    );
  }
  if (!unseen) return null;
  const c = countResults(job.results);
  return (
    <div className="animate-slide-up flex h-7 items-center gap-1 rounded-md border border-line bg-raised pl-2.5 pr-1 text-xs">
      <button onClick={() => openDialog("directory")} className="flex items-center gap-1.5 outline-none hover:text-fg">
        {c.failed ? <AlertTriangle className="size-3.5 text-amber" /> : <Check className="size-3.5 text-green" />}
        <span className="font-mono">{summarizeResults(job.results, job.status === "cancelled")}</span>
      </button>
      <IconButton label="Dismiss" size="icon-xs" onClick={dismiss}>
        <X />
      </IconButton>
    </div>
  );
}
