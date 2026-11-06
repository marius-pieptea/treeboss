import { AlertTriangle, ChevronRight, Check, Columns2, Crosshair, Eye, FileX, History, Save, WrapText } from "lucide-react";
import { bytes, cn } from "@/lib/utils";
import { Button, IconButton } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { formatCombo } from "@/lib/hooks";

export interface Banner {
  kind: "conflict" | "external" | "deleted" | "restored";
  /** mtime of the file on disk when the conflict was found. */
  diskMtime?: number;
}

export function Breadcrumb({ path, dirty, saving, canPreview, mode, onMode, wrap, onWrap, onSave, onReveal }: { path: string; dirty: boolean; saving: boolean; canPreview: boolean; mode: "edit" | "preview"; onMode: (m: "edit" | "preview") => void; wrap: boolean; onWrap: () => void; onSave: () => void; onReveal: () => void }) {
  const parts = path.split("/");
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-xs text-fg-muted">
        {parts.map((p, i) => (
          <span key={i} className="flex min-w-0 items-center gap-0.5">
            {i > 0 && <ChevronRight className="size-3 shrink-0 text-fg-faint" />}
            <span className={cn("truncate", i === parts.length - 1 && "font-medium text-fg")}>{p}</span>
          </span>
        ))}
        {dirty && <span className="ml-1.5 shrink-0 rounded bg-amber/15 px-1 font-mono text-[10px] text-amber animate-pop">modified</span>}
      </div>
      {canPreview && (
        <div className="flex items-center rounded-md bg-raised p-0.5">
          {(["edit", "preview"] as const).map((m) => (
            <button key={m} onClick={() => onMode(m)} aria-pressed={mode === m} className={cn("flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium outline-none transition-colors", mode === m ? "bg-panel text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg")}>
              {m === "edit" ? <Columns2 className="size-3" /> : <Eye className="size-3" />}
              {m === "edit" ? "Source" : "Preview"}
            </button>
          ))}
        </div>
      )}
      <IconButton label={wrap ? "Word wrap: on" : "Word wrap: off"} shortcut="Alt+Z" size="icon-sm" onClick={onWrap} className={cn(wrap && "bg-accent-soft text-accent")}>
        <WrapText />
      </IconButton>
      <IconButton label="Reveal in explorer" size="icon-sm" onClick={onReveal}>
        <Crosshair />
      </IconButton>
      {dirty && (
        <Button variant="primary" size="xs" onClick={onSave} disabled={saving} className="animate-in fade-in-0 zoom-in-95">
          {saving ? <Spinner className="size-3 text-accent-fg" /> : <Save />}
          Save
          <span className="ml-0.5 font-mono text-[10px] opacity-70">{formatCombo({ key: "s", mod: true })}</span>
        </Button>
      )}
    </div>
  );
}

/** A strip under the breadcrumb for things that need a decision: the file changed under you, was deleted, or has restored edits. */
export function BannerStrip({ banner, onReload, onOverwrite, onKeepMine, onCompare, onDismiss, onCloseTab }: { banner: Banner; onReload: () => void; onOverwrite: () => void; onKeepMine: () => void; onCompare: () => void; onDismiss: () => void; onCloseTab: () => void }) {
  const base = "flex shrink-0 items-center gap-3 border-b px-3 py-1.5 text-xs animate-in slide-in-from-top-1 fade-in-0 duration-200";
  if (banner.kind === "restored")
    return (
      <div className={cn(base, "border-accent/25 bg-accent-soft text-fg")}>
        <History className="size-3.5 shrink-0 text-accent" />
        <span className="flex-1">Restored your unsaved changes from earlier.</span>
        <Button size="xs" variant="ghost" onClick={onReload}>
          Discard them
        </Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  if (banner.kind === "deleted")
    return (
      <div className={cn(base, "border-red/25 bg-red/10 text-fg")}>
        <FileX className="size-3.5 shrink-0 text-red" />
        <span className="flex-1">This file was deleted on disk. Saving will create it again.</span>
        <Button size="xs" variant="ghost" onClick={onCloseTab}>
          Close tab
        </Button>
      </div>
    );
  return (
    <div className={cn(base, "border-amber/30 bg-amber/10 text-fg")} role="alert">
      <AlertTriangle className="size-3.5 shrink-0 text-amber" />
      <span className="flex-1">{banner.kind === "conflict" ? "This file changed on disk since you opened it, so your save was held back." : "This file changed on disk while you have unsaved edits."}</span>
      <Button size="xs" variant="outline" onClick={onCompare}>
        Compare
      </Button>
      {banner.kind === "conflict" ? (
        <Button size="xs" variant="danger" onClick={onOverwrite}>
          Overwrite
        </Button>
      ) : (
        <Button size="xs" variant="outline" onClick={onKeepMine}>
          Keep mine
        </Button>
      )}
      <Button size="xs" variant="subtle" onClick={onReload}>
        Reload from disk
      </Button>
    </div>
  );
}

export interface StatusInfo {
  line: number;
  col: number;
  selected: number;
  ranges: number;
  lines: number;
}

export function StatusStrip({ status, language, indent, eol, onEol, size, savedAt, saving }: { status: StatusInfo; language: string; indent: string; eol: "lf" | "crlf"; onEol: () => void; size: number; savedAt: number; saving: boolean }) {
  const item = "flex h-full items-center px-2";
  const justSaved = Date.now() - savedAt < 2500;
  return (
    <div className="flex h-6 shrink-0 items-stretch justify-between border-t border-line bg-bg font-mono text-[11px] text-fg-muted">
      <div className="flex items-stretch">
        <span className={item}>
          Ln {status.line}, Col {status.col}
        </span>
        {status.selected > 0 && (
          <span className={item}>
            {status.selected} selected{status.ranges > 1 ? ` · ${status.ranges} cursors` : ""}
          </span>
        )}
        {status.selected === 0 && status.ranges > 1 && <span className={item}>{status.ranges} cursors</span>}
        <span className={cn(item, "text-fg-faint")}>{status.lines} lines</span>
      </div>
      <div className="flex items-stretch">
        {saving ? (
          <span className={cn(item, "gap-1.5 text-fg-muted")}>
            <Spinner className="size-3" /> Saving
          </span>
        ) : (
          justSaved && (
            <span className={cn(item, "gap-1 text-green animate-pop")}>
              <Check className="size-3" /> Saved
            </span>
          )
        )}
        <span className={item}>{indent}</span>
        <span className={item}>UTF-8</span>
        <button onClick={onEol} title="Click to change the line endings used on save" className={cn(item, "outline-none transition-colors hover:bg-hover hover:text-fg")}>
          {eol === "crlf" ? "CRLF" : "LF"}
        </button>
        <span className={item}>{language}</span>
        <span className={cn(item, "text-fg-faint")}>{bytes(size)}</span>
      </div>
    </div>
  );
}

