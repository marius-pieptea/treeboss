import { useState } from "react";
import { Download, ExternalLink, FileQuestion, Maximize2, Minimize2 } from "lucide-react";
import { url } from "@/lib/api";
import { basename, bytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { LinkButton } from "@/components/ui/files-linkbutton";
import { mediaKind } from "./language";

/** Images, video and audio straight from the raw endpoint. */
export function MediaView({ root, path }: { root: string; path: string }) {
  const kind = mediaKind(path);
  const src = url.fs(root, "raw", { path });
  const [fit, setFit] = useState(true);
  const [dims, setDims] = useState<string | null>(null);

  if (kind === "video")
    return (
      <div className="flex h-full items-center justify-center bg-bg p-6">
        <video src={src} controls className="max-h-full max-w-full rounded-lg" />
      </div>
    );
  if (kind === "audio")
    return (
      <div className="flex h-full items-center justify-center bg-bg p-6">
        <audio src={src} controls className="w-[420px] max-w-full" />
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3 text-xs text-fg-muted">
        <span className="font-mono">{dims ?? "Loading…"}</span>
        <Button variant="ghost" size="xs" onClick={() => setFit(!fit)}>
          {fit ? <Maximize2 /> : <Minimize2 />}
          {fit ? "Actual size" : "Fit"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[conic-gradient(var(--raised)_25%,transparent_0_50%,var(--raised)_0_75%,transparent_0)] bg-[length:16px_16px]">
        <div className={fit ? "flex h-full items-center justify-center p-6" : "p-6"}>
          <img src={src} alt={basename(path)} onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} className={fit ? "max-h-full max-w-full object-contain shadow-pop" : "max-w-none"} />
        </div>
      </div>
    </div>
  );
}

/** A file the editor cannot show as text: say why, and offer the bytes. */
export function FileCard({ root, path, size, reason }: { root: string; path: string; size: number; reason: "binary" | "too-large" | "pdf" }) {
  const raw = url.fs(root, "raw", { path });
  const why = reason === "binary" ? "This is a binary file." : reason === "pdf" ? "PDFs open in your browser's own viewer." : "This file is larger than the 2 MB the editor will open.";
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex w-[360px] animate-slide-up flex-col items-center gap-3 rounded-xl border border-line bg-raised/40 p-6 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl border border-line bg-raised text-fg-faint">
          <FileQuestion className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{basename(path)}</div>
          <div className="mt-0.5 font-mono text-[11px] text-fg-faint">{bytes(size)}</div>
        </div>
        <p className="text-xs leading-relaxed text-fg-muted">{why}</p>
        <div className="flex gap-2">
          <LinkButton href={raw} target="_blank" rel="noopener noreferrer">
            <ExternalLink /> Open
          </LinkButton>
          <LinkButton variant="primary" href={raw} download={basename(path)}>
            <Download /> Download
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
