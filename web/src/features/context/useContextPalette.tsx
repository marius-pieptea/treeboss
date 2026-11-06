import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, Terminal as TerminalIcon, Globe, GitCommitHorizontal, Braces, FileText, FileArchive, FileDiff, ImageIcon, Map as MapIcon, Paperclip, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { get, post } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { setFollowView, useFollowView } from "./follow";
import { addChip, sameChip, chipFromCandidate, fileRefusal, filesFromItems, filesFromList, formatBytes, matchKeywords, removeMention, toPayload, urlFromQuery, type Candidate, type ChipKind, type ContextChip } from "./logic";

/** A popup row, in the shape the composer's own suggestion list uses. */
export interface PaletteEntry {
  key: string;
  node: ReactNode;
  apply: () => void;
}

export interface ContextPalette {
  chips: ContextChip[];
  /** What to send along with the message: `context: payload`. Empty when there are no chips. */
  payload: Array<{ kind: ChipKind; value: string; label: string }>;
  entries: PaletteEntry[];
  remove: (id: string) => void;
  clear: () => void;
  uploading: boolean;
  onPaste: (e: ClipboardEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  /** Open the system file picker (any number of files). */
  pickFiles: () => void;
  /** What is open in the editor, as a chip; null when there is nothing to attach. */
  view: Omit<ContextChip, "id"> | null;
  /** "Always attach what is in view": opt-in, remembered. While on, `autoChip` rides along with every message. */
  follow: boolean;
  setFollow: (on: boolean) => void;
  /** The in-view chip that will be sent without the operator adding it: shown in the composer, removable. */
  autoChip: Omit<ContextChip, "id"> | null;
  attachView: () => void;
  dismissAuto: () => void;
}

const ICON: Record<ChipKind, typeof FileText> = { file: FileText, symbol: Braces, commit: GitCommitHorizontal, url: Globe, terminal: TerminalIcon, browser: Camera, image: ImageIcon, upload: Paperclip, diff: FileDiff, roadmap: MapIcon };

const readBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

interface Args {
  root: string;
  mention: { start: number; query: string } | null;
  draft: string;
  caret: number;
  setDraft: (t: string) => void;
  /** Put the caret back in the text box after choosing something. */
  refocus: (caret: number) => void;
  /** The chip for the tab in view (see `viewChip`). */
  view?: Omit<ContextChip, "id"> | null;
}

/** Everything the composer needs for `@` context beyond plain files: chips, extra popup rows, image paste and drop. */
export function useContextPalette({ root, mention, draft, caret, setDraft, refocus, view = null }: Args): ContextPalette {
  const [chips, setChips] = useState<ContextChip[]>([]);
  const follow = useFollowView();
  const [uploading, setUploading] = useState(0);
  const seq = useRef(0);
  const nextId = () => `c${++seq.current}`;
  // The view the operator removed the auto chip for; a different view brings it back.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const viewKey = view ? `${view.kind}:${view.value}` : null;
  const autoChip = follow && view && viewKey !== dismissed && !chips.some((c) => sameChip(c, view)) ? view : null;
  const setFollow = (on: boolean) => {
    setDismissed(null);
    setFollowView(on);
  };

  const q = useDebounced(mention?.query ?? "", 150);
  const search = useQuery({
    queryKey: ["context-search", root, q],
    enabled: !!mention && !urlFromQuery(q),
    queryFn: () => get<{ items: Candidate[] }>(`/api/context/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`),
    staleTime: 10_000,
    retry: false,
  });

  const add = (chip: Omit<ContextChip, "id">) => {
    setChips((cur) => {
      const r = addChip(cur, chip, nextId);
      if (!r.added) queueMicrotask(() => toast.message(r.reason === "full" ? "That is as much context as one message takes" : "Already attached"));
      return r.list;
    });
  };

  const choose = (chip: Omit<ContextChip, "id">) => {
    add(chip);
    if (mention) {
      const r = removeMention(draft, mention, caret);
      setDraft(r.text);
      refocus(r.caret);
    }
  };

  const entries = useMemo<PaletteEntry[]>(() => {
    if (!mention) return [];
    const out: PaletteEntry[] = [];
    const row = (kind: ChipKind, label: string, detail?: string) => (
      <>
        {(() => {
          const I = ICON[kind];
          return <I className="size-3.5 shrink-0 text-fg-faint" />;
        })()}
        <span className="truncate">{label}</span>
        {detail && <span className="truncate font-mono text-[10.5px] text-fg-faint">{detail}</span>}
      </>
    );
    const url = urlFromQuery(mention.query);
    if (url) out.push({ key: "ctx-url", node: row("url", `Attach page ${url}`), apply: () => choose({ kind: "url", value: url, label: new URL(url).host }) });
    for (const k of matchKeywords(mention.query)) {
      out.push({
        key: `ctx-kw-${k.name}`,
        node: (
          <>
            <span className="font-mono text-accent">@{k.name}</span>
            <span className="ml-auto truncate text-[11px] text-fg-muted">{k.help}</span>
          </>
        ),
        apply: () => {
          if (k.name === "url") {
            // A URL needs typing: leave `@https://` in the box and let the popup offer it once it is complete.
            const next = draft.slice(0, mention.start) + "@https://" + draft.slice(caret);
            setDraft(next);
            refocus(mention.start + 9);
          } else if (k.name === "view") {
            if (view) choose(view);
            else toast.message("Nothing in view to attach");
          } else choose({ kind: k.name, value: "", label: k.name === "terminal" ? "terminal output" : "preview console" });
        },
      });
    }
    for (const c of (search.data?.items ?? []).filter((i) => i.kind !== "file")) out.push({ key: `ctx-${c.kind}-${c.value}`, node: row(c.kind, c.label, c.detail), apply: () => choose(chipFromCandidate(c)) });
    return out;
    // `choose` closes over the latest draft and caret, which change with the popup's own deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention?.start, mention?.query, search.data, draft, caret, viewKey]);

  const upload = async (files: File[]) => {
    // Bytes of uploads already on the message, plus the ones accepted in this batch (state lags inside the loop).
    let have = chips.reduce((n, c) => n + (c.bytes ?? 0), 0);
    for (const f of files) {
      const why = fileRefusal(f, have);
      if (why) {
        toast.error(why);
        continue;
      }
      have += f.size;
      setUploading((n) => n + 1);
      try {
        const data = await readBase64(f);
        const r = await post<{ id: string; kind: string; name: string; bytes: number }>("/api/context/files", { name: f.name || "pasted file", data });
        if (r.kind === "image") add({ kind: "image", value: r.id, label: f.name || "pasted image", bytes: r.bytes });
        else add({ kind: "upload", value: r.id, label: r.name, detail: formatBytes(r.bytes), bytes: r.bytes });
      } catch (e) {
        toast.error(`${f.name || "File"}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const pickFiles = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    input.setAttribute("data-context-file-input", "");
    input.onchange = () => {
      const picked = filesFromList(input.files);
      input.remove();
      if (picked.length) void upload(picked);
    };
    input.addEventListener("cancel", () => input.remove());
    document.body.appendChild(input);
    input.click();
  };

  return {
    chips,
    payload: toPayload(autoChip ? [...chips, { ...autoChip, id: "auto" }] : chips),
    entries,
    remove: (id) => setChips((cur) => cur.filter((c) => c.id !== id)),
    clear: () => setChips([]),
    view,
    follow,
    setFollow,
    autoChip,
    attachView: () => view && add(view),
    dismissAuto: () => setDismissed(viewKey),
    uploading: uploading > 0,
    pickFiles,
    onPaste: (e) => {
      const files = filesFromItems(e.clipboardData?.items);
      if (!files.length) return; // ordinary text paste
      e.preventDefault();
      void upload(files);
    },
    onDrop: (e) => {
      const files = filesFromList(e.dataTransfer?.files);
      if (!files.length) return;
      e.preventDefault();
      void upload(files);
    },
    onDragOver: (e) => {
      if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file")) e.preventDefault();
    },
  };
}

/** The chips under the text box, then the in-view offer. Renders nothing when there is neither. */
export function ContextChips({ ctx }: { ctx: ContextPalette }) {
  const offer = ctx.view && !ctx.autoChip && !ctx.chips.some((c) => sameChip(c, ctx.view!)) ? ctx.view : null;
  if (!ctx.chips.length && !ctx.uploading && !ctx.view) return null;
  const chip = (c: Omit<ContextChip, "id">, key: string, onRemove: () => void, auto = false) => {
    const I = ICON[c.kind];
    return (
      <span key={key} data-context-chip={c.kind} data-context-auto={auto || undefined} title={auto ? `${c.detail ?? c.label} · sent because it is in view` : c.detail ? `${c.label} · ${c.detail}` : c.value || c.label} className={cn("group inline-flex h-5 max-w-[220px] items-center gap-1 rounded-md border bg-raised pl-1.5 pr-0.5 text-[11px] text-fg-muted animate-pop", auto ? "border-dashed border-line-strong" : "border-line")}>
        {c.kind === "upload" && /\.zip$/i.test(c.label) ? <FileArchive className="size-3 shrink-0" /> : c.kind === "image" ? <img src={`/api/context/images/${c.value}`} alt="" className="size-3.5 shrink-0 rounded-sm object-cover" /> : <I className="size-3 shrink-0" />}
        <span className="truncate">{c.kind === "commit" ? `${c.value.slice(0, 7)} ${c.label}` : c.label}</span>
        {auto && <span className="shrink-0 text-[10px] text-fg-faint">in view</span>}
        {c.kind === "upload" && c.detail && <span className="shrink-0 font-mono text-[10px] text-fg-faint">{c.detail}</span>}
        <button type="button" aria-label={`Remove ${c.label}`} onClick={onRemove} className="flex size-4 items-center justify-center rounded outline-none hover:bg-hover">
          <X className="size-3" />
        </button>
      </span>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pb-1" data-context-chips>
      {ctx.chips.map((c) => chip(c, c.id, () => ctx.remove(c.id)))}
      {ctx.autoChip && chip(ctx.autoChip, "auto", ctx.dismissAuto, true)}
      {offer && (
        <button type="button" onClick={ctx.attachView} title={`Attach ${offer.detail ?? offer.label}`} data-context-offer className="inline-flex h-5 max-w-[220px] items-center gap-1 rounded-md border border-dashed border-line px-1.5 text-[11px] text-fg-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-accent">
          <Plus className="size-3 shrink-0" />
          <span className="truncate">{offer.label}</span>
        </button>
      )}
      {ctx.uploading && <span className="text-[11px] text-fg-faint">Uploading…</span>}
    </div>
  );
}
