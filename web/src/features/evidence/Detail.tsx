import { useEffect, useState } from "react";
import { BookText, ExternalLink, FileText, Hammer, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Badge, Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { FINDING_LABEL, FindingStatusSelect } from "./Findings";
import { partUrl, useCapturedStyles, useEvidenceActions, useEvidenceDetail, type CapturedStyles, type EvidenceItem } from "./data";

export const ago = (iso: string) => new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`).toLocaleString();

/** Swatches and lists for the design values a page really used. The colors are the captured site's own data, shown as-is. */
function Styles({ styles }: { styles: CapturedStyles }) {
  const row = (label: string, pairs: Array<[string, number]>, swatch = false) =>
    pairs.length ? (
      <div className="grid grid-cols-[88px_1fr] items-start gap-2 text-xs">
        <span className="pt-0.5 uppercase tracking-wider text-fg-muted">{label}</span>
        <span className="flex flex-wrap gap-1">
          {pairs.slice(0, 12).map(([v, n]) => (
            <span key={v} title={`${n} uses`} className="inline-flex items-center gap-1.5 rounded border border-line bg-panel px-1.5 py-0.5 font-mono">
              {swatch && <span className="size-3 rounded-sm border border-line-strong" style={{ background: v }} />}
              {v.length > 40 ? `${v.slice(0, 39)}…` : v}
            </span>
          ))}
        </span>
      </div>
    ) : null;
  return (
    <div className="flex flex-col gap-2">
      {row("Background", styles.colors.background, true)}
      {row("Text", styles.colors.text, true)}
      {row("Border", styles.colors.border, true)}
      {row("Fonts", styles.fonts.families)}
      {row("Sizes", styles.fonts.sizes)}
      {row("Radii", styles.radii)}
      {row("Shadows", styles.shadows)}
      {row("Spacing", styles.spacing)}
      {Object.keys(styles.tokens).length > 0 && (
        <div className="grid grid-cols-[88px_1fr] items-start gap-2 text-xs">
          <span className="pt-0.5 uppercase tracking-wider text-fg-muted">Variables</span>
          <span className="font-mono text-fg-muted">{Object.keys(styles.tokens).length} CSS custom properties on :root (see styles.json)</span>
        </div>
      )}
    </div>
  );
}

/** The item as the operator reads it: what it is, its parts, what it cites, and for a finding, build and status. */
export function Detail({ root, item, onGone, onBuild, building }: { root: string; item: EvidenceItem; onGone: () => void; onBuild: (ids: string[]) => void; building: boolean }) {
  const detail = useEvidenceDetail(root, item.id);
  const styles = useCapturedStyles(root, item);
  const act = useEvidenceActions(root);
  const [part, setPart] = useState<string | null>(null);
  // An REA result is the thing to read: its text report, else its JSON.
  const reaPart = item.source === "rea" ? ("rea.txt" in item.files ? "rea.txt" : "rea.json" in item.files ? "rea.json" : null) : null;
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold leading-tight">{item.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
            <Badge tone={item.kind === "page" ? "blue" : "neutral"}>{item.kind}</Badge>
            {item.finding && <Badge>{FINDING_LABEL[item.finding]}</Badge>}
            {item.source === "rea" && <Badge title="Produced by REA">REA</Badge>}
            <span className="font-mono">{item.id}</span>
            <span>{ago(item.created_at)}</span>
            <span>{Math.round(item.bytes / 1024)} KB</span>
          </div>
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-primary hover:underline">
              <ExternalLink className="size-3 shrink-0" /> <span className="truncate">{item.url}</span>
            </a>
          )}
        </div>
        {item.finding && (
          <>
            <FindingStatusSelect item={item} onChange={(status) => act.setFindingStatus.mutate({ id: item.id, status })} />
            <Button variant="primary" onClick={() => onBuild([item.id])} disabled={building} title="Hand this finding to a new agent session as a build brief">
              {building ? <Spinner /> : <Hammer />} Build this
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={() => act.exportDoc.mutate(item.id)} disabled={act.exportDoc.isPending}>
          <BookText /> Export to docs
        </Button>
        <IconButton
          label="Delete"
          onClick={() => {
            void confirm({ title: `Delete "${item.title}"?`, description: "Notes that cite it keep the id.", confirmLabel: "Delete", danger: true }).then((yes) => yes && act.remove.mutate(item.id, { onSuccess: onGone }));
          }}
        >
          <Trash2 />
        </IconButton>
      </div>

      {item.summary && <p className="text-[13px] leading-relaxed text-fg-muted">{item.summary}</p>}

      {item.kind === "page" && "screenshot.jpg" in item.files && (
        <a href={partUrl(root, item.id, "screenshot.jpg")} target="_blank" rel="noreferrer noopener" className="block max-h-[360px] overflow-auto rounded-lg border border-line bg-raised">
          <img src={partUrl(root, item.id, "screenshot.jpg")} alt={`Screenshot of ${item.title}`} className="w-full" loading="lazy" />
        </a>
      )}

      {item.kind === "note" && "note.md" in item.files && <PartText root={root} id={item.id} part="note.md" />}

      {reaPart && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-muted">REA result · {reaPart}</h3>
          <PartText root={root} id={item.id} part={reaPart} />
        </section>
      )}

      {styles.data && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-fg-muted">Measured design values</h3>
          <Styles styles={styles.data} />
        </section>
      )}

      {detail.data && (detail.data.cites.length > 0 || detail.data.citedBy.length > 0) && (
        <section className="flex flex-col gap-1.5 text-xs">
          {detail.data.cites.length > 0 && <Links label="Cites" items={detail.data.cites} />}
          {detail.data.citedBy.length > 0 && <Links label="Cited by" items={detail.data.citedBy} />}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(item.files)
            .filter(([f]) => f !== "screenshot.jpg")
            .map(([f, size]) => (
              <button key={f} onClick={() => setPart(part === f ? null : f)} aria-pressed={part === f} className={cn("inline-flex items-center gap-1.5 rounded border border-line bg-panel px-2 py-1 font-mono text-xs text-fg-muted hover:bg-hover", part === f && "bg-primary-soft text-fg")}>
                <FileText className="size-3" /> {f} <span className="text-fg-faint">{size > 1024 ? `${Math.round(size / 1024)} KB` : `${size} B`}</span>
              </button>
            ))}
        </div>
        {part && <PartText key={`${item.id}/${part}`} root={root} id={item.id} part={part} />}
      </section>
    </div>
  );
}

const PART_CHARS = 60_000;

/** One stored part as plain text, never rendered as markup: a captured page's own HTML must not run here. */
export function PartText({ root, id, part }: { root: string; id: string; part: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(partUrl(root, id, part), { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((t) => live && setText(t))
      .catch(() => live && setText("(could not be loaded)"));
    return () => {
      live = false;
    };
  }, [root, id, part]);
  if (text === null) return <Spinner />;
  return (
    <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-panel p-3 font-mono text-xs leading-relaxed">
      {text.slice(0, PART_CHARS)}
      {text.length > PART_CHARS ? `\n… [${text.length - PART_CHARS} more characters]` : ""}
    </pre>
  );
}

function Links({ label, items }: { label: string; items: EvidenceItem[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="uppercase tracking-wider text-fg-muted">{label}</span>
      {items.map((i) => (
        <span key={i.id} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono" title={i.title}>
          {i.id}
        </span>
      ))}
    </div>
  );
}
