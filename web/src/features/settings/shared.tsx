import * as React from "react";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { looksSecret } from "./logic";
import { EngineIcon, ModelIcon } from "@/components/ui/engine-icon";
import { showsModelMark } from "@/lib/models-logic";

/** A page: a scrolling column with a sticky title row. All five settings pages share this chrome. */
export function PageShell({ title, description, actions, children, wide }: { title: string; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-panel">
      <div className={cn("mx-auto flex min-w-0 flex-col gap-5 px-8 pb-12 pt-6", wide ? "max-w-[1100px]" : "max-w-[900px]")}>
        <header className="flex items-start gap-4 animate-slide-up">
          <div className="min-w-0 flex-1">
            <h1 className="text-[18px] font-semibold tracking-tight">{title}</h1>
            {description && <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-fg-muted">{description}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Engines are identified by colour first: a row of pairs is scanned, not read. */
const ENGINE_TONE: Record<string, string> = {
  claude: "var(--amber)",
  codex: "var(--green)",
  cursor: "var(--blue)",
  opencode: "var(--violet)",
  agy: "var(--accent)",
  grok: "var(--red)",
  fake: "var(--fg-faint)",
};

export function engineTone(id: string | null | undefined): string {
  return (id && ENGINE_TONE[id]) || "var(--fg-muted)";
}

export function EngineChip({ id, model, effort, missing, className, icon = true }: { icon?: boolean; id: string | null | undefined; model?: string | null; effort?: string | null; missing?: boolean; className?: string }) {
  if (!id) return <span className={cn("text-xs text-fg-faint", className)}>inherits</span>;
  const tone = engineTone(id);
  return (
    <span title={missing ? `${id} is not installed` : id} className={cn("inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-md border bg-raised px-2 font-mono text-[11px]", missing ? "border-amber/40" : "border-line", className)}>
      {icon && <EngineIcon engine={id} className="size-3" />}
      <span className="font-medium" style={{ color: tone }}>
        {id}
      </span>
      {model && (
        <span className="flex min-w-0 items-center gap-1 text-fg-muted">
          {showsModelMark(id, model) && <ModelIcon model={model} engine={id} className="size-3" />}
          <span className="truncate">{model.split("/").pop()}</span>
        </span>
      )}
      {effort && <span className="shrink-0 text-fg-faint">@{effort}</span>}
      {missing && <span className="text-amber">!</span>}
    </span>
  );
}

/** An editable list of key/value pairs (environment variables, HTTP headers). Values that look like credentials are masked until revealed. */
export interface KV {
  k: string;
  v: string;
}

export function kvToRecord(rows: KV[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.k.trim()) out[r.k.trim()] = r.v;
  return out;
}

export function recordToKv(rec: Record<string, string> | undefined): KV[] {
  return Object.entries(rec ?? {}).map(([k, v]) => ({ k, v }));
}

export function KeyValueEditor({ rows, onChange, keyPlaceholder = "NAME", valuePlaceholder = "value", addLabel = "Add" }: { rows: KV[]; onChange: (rows: KV[]) => void; keyPlaceholder?: string; valuePlaceholder?: string; addLabel?: string }) {
  const [revealed, setRevealed] = React.useState<Record<number, boolean>>({});
  const set = (i: number, patch: Partial<KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => {
        const secret = looksSecret(r.k) && !revealed[i];
        return (
          <div key={i} className="flex items-center gap-1.5 animate-slide-up">
            <Input value={r.k} onChange={(e) => set(i, { k: e.target.value })} placeholder={keyPlaceholder} spellCheck={false} className="h-7 w-[38%] font-mono text-xs" aria-label="Name" />
            <Input value={r.v} onChange={(e) => set(i, { v: e.target.value })} placeholder={valuePlaceholder} type={secret ? "password" : "text"} spellCheck={false} autoComplete="off" className="h-7 flex-1 font-mono text-xs" aria-label="Value" />
            {looksSecret(r.k) && (
              <Button variant="ghost" size="icon-sm" onClick={() => setRevealed({ ...revealed, [i]: !revealed[i] })} aria-label={revealed[i] ? "Hide value" : "Reveal value"} title={revealed[i] ? "Hide" : "Reveal"}>
                {revealed[i] ? <EyeOff /> : <Eye />}
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove">
              <X />
            </Button>
          </div>
        );
      })}
      <Button variant="ghost" size="xs" className="self-start" onClick={() => onChange([...rows, { k: "", v: "" }])}>
        <Plus /> {addLabel}
      </Button>
    </div>
  );
}

/** A value shown masked until the eye is clicked; for summaries of stored secrets. */
export function Masked({ text }: { text: string }) {
  const [show, setShow] = React.useState(false);
  return (
    <span className="inline-flex items-center gap-1 font-mono">
      <span>{show ? text : "•".repeat(Math.min(text.length, 10))}</span>
      <button onClick={() => setShow(!show)} className="text-fg-faint outline-none hover:text-fg" aria-label={show ? "Hide" : "Reveal"}>
        {show ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
      </button>
    </span>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-red/30 bg-red/10 px-3 py-2 text-xs leading-relaxed text-red">{children}</div>;
}

export function WarnNote({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-amber/30 bg-amber/10 px-3 py-2 text-xs leading-relaxed text-amber">{children}</div>;
}

export function Card({ children, className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("rounded-xl border border-line bg-bg/40 transition-colors hover:border-line-strong", className)} {...props}>
      {children}
    </div>
  );
}
