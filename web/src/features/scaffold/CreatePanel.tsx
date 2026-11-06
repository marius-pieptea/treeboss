import { FolderOpen, X } from "lucide-react";
import { IconButton } from "@/components/ui/button";

/** Home screen: the inline frame for creating a project. The folder comes from the browser beside it, never from typing. */
export function CreatePanel({ title, description, location, onClose, busy, footer, children }: { title: string; description: string; location: string; onClose: () => void; busy: boolean; footer: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
        </div>
        <IconButton label="Close" onClick={onClose} disabled={busy}>
          <X />
        </IconButton>
      </div>
      <div className="rounded-lg border border-line bg-panel px-3 py-2" data-create-location>
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-fg-muted">
          <FolderOpen className="size-3.5" /> Creating inside
        </div>
        <div className="mt-0.5 truncate font-mono text-xs" title={location}>
          {location || "…"}
        </div>
        <div className="mt-0.5 text-[11px] text-fg-faint">Browse to a different folder on the right to change it.</div>
      </div>
      {children}
      <div className="flex justify-end gap-2">{footer}</div>
    </section>
  );
}
