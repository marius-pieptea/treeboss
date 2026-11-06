import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Check, ChevronRight, EyeOff, FileCode2, Gauge, ListChecks, Play, Search } from "lucide-react";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { currentPhase, filterTasks, groupByPhase, percent, type FeatureInfo, type ParsedTasks, type SpecTask } from "./logic";

function Box({ done, label, onToggle }: { done: boolean; label: string; onToggle: () => void }) {
  return (
    <button role="checkbox" aria-checked={done} aria-label={label} data-task-box onClick={onToggle} className={cn("mt-px flex size-4 shrink-0 items-center justify-center rounded border outline-none transition-[background,border-color,transform] duration-150 active:scale-90 focus-visible:ring-2 focus-visible:ring-accent/50", done ? "border-accent bg-accent text-accent-fg" : "border-line-strong bg-transparent hover:border-accent")}>
      {done && <Check className="size-3 animate-pop" strokeWidth={3} />}
    </button>
  );
}

function Row({ t, root, onToggle, onRun }: { t: SpecTask; root: string; onToggle: () => void; onRun: () => void }) {
  const openTab = useUi((s) => s.openTab);
  return (
    <div data-task-row data-line={t.line} data-done={t.done} className="group flex items-start gap-2 rounded-md px-2 py-[5px] transition-colors hover:bg-hover focus-within:bg-hover" style={{ paddingLeft: 8 + Math.min(t.indent, 8) * 4 }}>
      <Box done={t.done} label={`${t.id ?? `Line ${t.line + 1}`}: ${t.text}`} onToggle={onToggle} />
      <span className="mt-px w-9 shrink-0 font-mono text-[11px] text-fg-faint">{t.id ?? `l${t.line + 1}`}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {t.parallel && (
          <Badge tone="blue" title="Can run alongside its neighbours">
            P
          </Badge>
        )}
        {t.story && <Badge tone="amber">{t.story}</Badge>}
        <span className={cn("text-[13px] leading-snug transition-colors", t.done && "text-fg-faint line-through decoration-fg-faint/40")}>{t.text}</span>
        {t.file && (
          <button onClick={() => openTab({ kind: "file", root, path: t.file!, title: t.file!.split("/").pop()! })} className="inline-flex max-w-[260px] items-center gap-1 rounded bg-raised px-1 font-mono text-[10.5px] text-fg-muted outline-none hover:text-accent focus-visible:text-accent" title={`Open ${t.file}`}>
            <FileCode2 className="size-3 shrink-0" />
            <span className="truncate">{t.file}</span>
          </button>
        )}
      </div>
      {!t.done && (
        <button aria-label={`Run ${t.id ?? "this task"}`} title="Run this task" data-task-run onClick={onRun} className="flex size-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 outline-none transition-opacity hover:bg-active hover:text-accent focus-visible:opacity-100 group-hover:opacity-100 [&_svg]:size-3">
          <Play />
        </button>
      )}
    </div>
  );
}

/** tasks.md as a checklist: phases, [P] and [US#] chips, a box that writes the file, and a run button per task. */
export function TasksChecklist({ root, feature, parsed, onToggle, onRun, onImplement }: { root: string; feature: FeatureInfo; parsed: ParsedTasks; onToggle: (t: SpecTask) => void; onRun: (t: SpecTask) => void; onImplement: (parallel: boolean) => void }) {
  const openTab = useUi((s) => s.openTab);
  const [query, setQuery] = useState("");
  const [hideDone, setHideDone] = useState(false);
  const [onlyP, setOnlyP] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const list = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => filterTasks(parsed.tasks, { query, hideDone, onlyParallel: onlyP }), [parsed.tasks, query, hideDone, onlyP]);
  const phases = useMemo(() => groupByPhase(visible, parsed.tasks), [visible, parsed.tasks]);
  const current = currentPhase(groupByPhase(parsed.tasks, parsed.tasks));
  // A phase is open unless the user closed it, or (when they have not touched it) it is finished.
  const isClosed = (title: string, done: number, total: number) => closed[title] ?? (done === total && total > 0 && title !== current);
  const pct = percent(parsed.done, parsed.total);
  const hasParallel = parsed.tasks.some((t) => !t.done && t.parallel);
  const filtering = query.trim() !== "" || hideDone || onlyP;

  // Up and down move between rows' boxes; space and enter toggle (the box is a real button).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const boxes = [...(list.current?.querySelectorAll<HTMLElement>("[data-task-box]") ?? [])];
    const i = boxes.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    boxes[Math.max(0, Math.min(boxes.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-tasks-checklist>
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className="text-[13px] font-semibold tabular-nums">
                {parsed.done}/{parsed.total} done
              </span>
              <span className="font-mono text-[11px] text-fg-faint">{pct}%</span>
            </div>
            <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-active">
              <div className={cn("h-full rounded-full transition-[width] duration-200 ease-out", pct === 100 ? "bg-green" : "bg-accent")} style={{ width: `${pct}%` }} />
            </div>
          </div>
          {parsed.done < parsed.total && (
            <>
              <Button size="sm" variant="primary" data-implement onClick={() => onImplement(false)}>
                <Gauge /> Implement
              </Button>
              {hasParallel && (
                <Button size="sm" variant="outline" data-implement-parallel onClick={() => onImplement(true)} title="One head per group of [P] tasks">
                  In parallel
                </Button>
              )}
            </>
          )}
        </div>
        <div className="mt-2.5 flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter tasks" aria-label="Filter tasks" className="h-7 pl-7 text-xs" />
          </div>
          <button aria-pressed={hideDone} onClick={() => setHideDone(!hideDone)} className={cn("flex h-7 items-center gap-1 rounded-md border px-2 text-[11.5px] outline-none transition-colors", hideDone ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-fg-muted hover:bg-hover")}>
            <EyeOff className="size-3" /> Hide done
          </button>
          <button aria-pressed={onlyP} onClick={() => setOnlyP(!onlyP)} className={cn("flex h-7 items-center gap-1 rounded-md border px-2 text-[11.5px] outline-none transition-colors", onlyP ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-fg-muted hover:bg-hover")}>
            [P] only
          </button>
        </div>
        {parsed.malformed.length > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-amber">
            <AlertTriangle className="size-3.5 shrink-0" /> {parsed.malformed.length} checkbox line{parsed.malformed.length === 1 ? " has" : "s have"} no description and {parsed.malformed.length === 1 ? "is" : "are"} ignored.
            <button className="underline outline-none hover:text-fg" onClick={() => openTab({ kind: "file", root, path: `${feature.dir}/tasks.md`, title: "tasks.md", line: parsed.malformed[0].line + 1 })}>
              Open
            </button>
          </p>
        )}
      </div>

      <div ref={list} onKeyDown={onKey} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {phases.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center text-[12.5px] text-fg-muted">
            <ListChecks className="size-6 text-fg-faint" />
            {filtering ? "No task matches the filter." : "tasks.md has no tasks yet."}
          </div>
        ) : (
          phases.map((p) => {
            const shut = !filtering && isClosed(p.title, p.done, p.total);
            return (
              <section key={p.title} className="mb-2" data-phase={p.title}>
                <button onClick={() => setClosed({ ...closed, [p.title]: !shut })} aria-expanded={!shut} className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left outline-none hover:bg-hover focus-visible:bg-hover">
                  <ChevronRight className={cn("size-3.5 shrink-0 text-fg-faint transition-transform duration-150", !shut && "rotate-90")} />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-fg-muted group-hover:text-fg">{p.title}</span>
                  <span className={cn("font-mono text-[10.5px] tabular-nums", p.done === p.total ? "text-green" : "text-fg-faint")}>
                    {p.done}/{p.total}
                  </span>
                </button>
                <div className={cn("grid transition-[grid-template-rows] duration-200 ease-out", shut ? "grid-rows-[0fr]" : "grid-rows-[1fr]")}>
                  <div className="min-h-0 overflow-hidden">
                    {p.tasks.map((t) => (
                      <Row key={t.line} t={t} root={root} onToggle={() => onToggle(t)} onRun={() => onRun(t)} />
                    ))}
                  </div>
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
