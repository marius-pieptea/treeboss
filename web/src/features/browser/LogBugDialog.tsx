import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { post } from "@/lib/api";
import { Button, IconButton } from "@/components/ui/button";
import { Field, Input, Select, Switch, Textarea, type Option } from "@/components/ui/form";
import { Badge } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { useIssues } from "../run/data";
import { openBugs } from "../lab/open";
import { BUG_KINDS, type BugKind } from "../lab/logic";
import type { Shot } from "./capture";
import { MAX_BUG_STEP as MAX_STEP, MAX_BUG_STEPS as MAX_STEPS, MAX_TITLE, initialDraft, moveItem, type BugPrefill } from "./logic";

const KIND_OPTIONS: Option[] = [
  { value: "functional", label: "Functional", hint: "Something doesn't work" },
  { value: "visual", label: "Visual", hint: "Layout or styling" },
  { value: "logic", label: "Logic", hint: "Wrong data or result" },
  { value: "content", label: "Content", hint: "Copy, text, images" },
  { value: "performance", label: "Performance", hint: "Slow or janky" },
];

export interface LoggedBug {
  finding: { id: string; title: string };
  capture: { id: string } | null;
  shotNote: string | null;
}

/** The body of POST /api/lab/:root/bugs. */
export function bugBody(i: { title: string; kind: BugKind; steps: string[]; expected: string; actual: string; url: string; port: number | null; shot: Shot | null; screenshot: boolean; console: boolean; logs: boolean }) {
  return {
    title: i.title.trim(),
    kind: i.kind,
    steps: i.steps.map((l) => l.trim().slice(0, MAX_STEP)).filter(Boolean).slice(0, MAX_STEPS),
    expected: i.expected.trim(),
    actual: i.actual.trim(),
    url: i.url,
    port: i.port,
    attach: { console: i.console, logs: i.logs },
    shot: i.screenshot && i.shot ? (i.shot.kind === "desktop" ? { kind: "desktop", png: i.shot.png } : { kind: "rerender", viewport: i.shot.viewport }) : { kind: "none" },
  };
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] text-fg">{label}</div>
        {hint && <div className="text-xs text-fg-muted">{hint}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export function LogBugDialog({ open, onOpenChange, root, url, port, shot, steps, prefill, onLogged }: { open: boolean; onOpenChange: (o: boolean) => void; root: string; url: string; port: number | null; shot: Shot | null; steps: string[]; prefill?: BugPrefill; onLogged?: (findingId: string | null) => void }) {
  const qc = useQueryClient();
  const issues = useIssues(port, open);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<BugKind>("functional");
  const [lines, setLines] = useState<Array<{ id: number; text: string }>>([]);
  const nextId = useRef(0);
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState("");
  const [screenshot, setScreenshot] = useState(true);
  const [console_, setConsole] = useState(true);
  const [logs, setLogs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const d = initialDraft(prefill, steps);
    setTitle(d.title);
    setKind(d.kind);
    setLines(d.steps.map((text) => ({ id: nextId.current++, text })));
    setExpected(d.expected);
    setActual(d.actual);
    setScreenshot(true);
    setConsole(true);
    setLogs(true);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = issues.data?.count ?? issues.data?.issues.length ?? 0;
  const cancel = () => {
    onLogged?.(null);
    onOpenChange(false);
  };
  const save = async () => {
    if (!title.trim()) return setError("Give the bug a title.");
    setBusy(true);
    setError(null);
    try {
      const r = await post<LoggedBug>(`/api/lab/${root}/bugs`, bugBody({ title, kind, steps: lines.map((l) => l.text), expected, actual, url, port, shot, screenshot, console: console_, logs }));
      void qc.invalidateQueries({ queryKey: ["lab", root] });
      onLogged?.(r.finding.id);
      onOpenChange(false);
      toast.success("Bug logged", { description: r.shotNote ?? r.finding.title, action: { label: "Open bugs", onClick: () => openBugs() } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && (o ? onOpenChange(o) : cancel())}
      title="Log bug"
      description="Saved as a finding in this project, with what the page and the dev server reported."
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !title.trim()}>
            {busy ? "Saving…" : "Save bug"}
          </Button>
        </>
      }
    >
      <form
        className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {shot && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Badge tone={shot.kind === "desktop" ? "green" : "neutral"}>{shot.kind === "desktop" ? "Live" : "Re-render"}</Badge>
              {shot.kind === "rerender" && <span className="text-xs text-fg-muted">Taken on save by reloading the page, so app state and sign-in are not in it.</span>}
            </div>
            {shot.kind === "desktop" && <img src={`data:image/png;base64,${shot.png}`} alt="Screenshot of the preview" className={`max-h-40 w-full rounded-md border border-line bg-raised object-contain ${screenshot ? "" : "opacity-40"}`} />}
          </div>
        )}
        <Field label="Title">
          <Input autoFocus value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} placeholder="What is wrong?" aria-invalid={!!error && !title.trim()} />
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={(v) => BUG_KINDS.includes(v as BugKind) && setKind(v as BugKind)} options={KIND_OPTIONS} aria-label="Kind of bug" />
        </Field>
        <Field label="Steps to reproduce" hint="Recorded from what you did in the preview. Edit, reorder or add lines.">
          <div className="flex flex-col gap-1.5">
            {lines.map((l, i) => (
              <div key={l.id} className="flex items-center gap-1">
                <span className="w-5 shrink-0 text-right font-mono text-xs text-fg-muted">{i + 1}.</span>
                <Input value={l.text} maxLength={MAX_STEP} aria-label={`Step ${i + 1}`} onChange={(e) => setLines((ls) => ls.map((x) => (x.id === l.id ? { ...x, text: e.target.value } : x)))} />
                <IconButton label="Move step up" size="icon-sm" disabled={i === 0} onClick={() => setLines((ls) => moveItem(ls, i, -1))} type="button">
                  <ArrowUp />
                </IconButton>
                <IconButton label="Move step down" size="icon-sm" disabled={i === lines.length - 1} onClick={() => setLines((ls) => moveItem(ls, i, 1))} type="button">
                  <ArrowDown />
                </IconButton>
                <IconButton label="Delete step" size="icon-sm" onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))} type="button">
                  <X />
                </IconButton>
              </div>
            ))}
            {!lines.length && <div className="text-xs text-fg-muted">Nothing was recorded yet. Add the steps by hand.</div>}
            <div>
              <Button variant="ghost" size="sm" type="button" disabled={lines.length >= MAX_STEPS} onClick={() => setLines((ls) => [...ls, { id: nextId.current++, text: "" }])}>
                <Plus /> Add step
              </Button>
            </div>
          </div>
        </Field>
        <Field label="Expected">
          <Textarea value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="What should have happened?" rows={2} />
        </Field>
        <Field label="What actually happened">
          <Textarea value={actual} onChange={(e) => setActual(e.target.value)} placeholder="What you saw instead." rows={3} />
        </Field>
        <div className="flex flex-col gap-2.5">
          <Toggle label="Screenshot" checked={screenshot} onChange={setScreenshot} />
          <Toggle label="Console" hint={port ? `${count} recorded for localhost:${port}` : "Only localhost previews record one"} checked={console_} onChange={setConsole} />
          <Toggle label="Server log" hint="The last 400 lines of the dev server on this port" checked={logs} onChange={setLogs} />
        </div>
        <Field label="URL">
          <Input value={url} readOnly className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        </Field>
        {error && <div className="text-xs text-red">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
