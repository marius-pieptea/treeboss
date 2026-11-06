import { Copy, ExternalLink, Globe, Square } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { post } from "@/lib/api";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { ListeningPort } from "@/lib/types";
import { Popover } from "@/components/ui/overlay";
import { Switch } from "@/components/ui/form";
import { IconButton } from "@/components/ui/button";
import { previewUrl } from "./usePorts";
import { useTermPrefs } from "./prefs";

export function openPreview(port: number) {
  useUi.getState().openTab({ kind: "browser", url: previewUrl(port), title: `localhost:${port}` });
}

/** The dev servers running in this workspace; click one to preview it. */
export function PortsChip({ ports, workspacePath }: { ports: ListeningPort[]; workspacePath: string }) {
  const { allPorts, setAllPorts } = useTermPrefs();
  const qc = useQueryClient();
  const stop = (p: ListeningPort) =>
    post("/api/ports/stop", { port: p.port, pid: p.pid }).then(
      () => {
        toast.success(`Stopped :${p.port}`);
        void qc.invalidateQueries({ queryKey: ["ports"] });
      },
      (e: Error) => toast.error(e.message),
    );
  const rel = (cwd: string | null) => (cwd && cwd.startsWith(workspacePath) ? cwd.slice(workspacePath.length).replace(/^\//, "") || "." : (cwd ?? ""));
  return (
    <Popover
      align="end"
      width={320}
      trigger={
        <button className={cn("flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-[11px] outline-none transition-colors", ports.length ? "border-accent/30 bg-accent-soft text-accent hover:bg-accent/20" : "border-line text-fg-faint hover:text-fg-muted")} aria-label="Dev servers">
          <span className={cn("size-1.5 rounded-full", ports.length ? "bg-accent animate-pulse-dot" : "bg-fg-faint")} />
          {ports.length ? (ports.length === 1 ? `:${ports[0].port}` : `${ports.length} servers`) : "no servers"}
        </button>
      }
    >
      <div className="flex items-center justify-between px-2 pb-1.5 pt-1 text-[11px] text-fg-muted">
        <span className="font-semibold uppercase tracking-wider">Dev servers</span>
        <label className="flex items-center gap-1.5">
          all
          <Switch checked={allPorts} onChange={setAllPorts} label="Show servers from every directory" />
        </label>
      </div>
      {ports.length === 0 ? (
        <div className="px-2 pb-2 text-xs leading-relaxed text-fg-faint">Nothing is listening{allPorts ? "" : " in this workspace"}. Start a dev server in a terminal and it shows up here.</div>
      ) : (
        <ul className="flex max-h-[60vh] flex-col overflow-y-auto">
          {ports.map((p) => (
            <li key={`${p.port}-${p.pid}`} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
              <Globe className="size-3.5 shrink-0 text-blue" />
              <button onClick={() => openPreview(p.port)} className="min-w-0 flex-1 text-left outline-none">
                <div className="font-mono text-[12.5px]">localhost:{p.port}</div>
                <div className="truncate text-[11px] text-fg-faint">
                  {p.command}
                  {p.cwd ? ` · ${rel(p.cwd)}` : ""}
                </div>
              </button>
              <div className="flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <IconButton label="Stop server" size="icon-sm" onClick={() => void stop(p)}>
                  <Square />
                </IconButton>
                <IconButton label="Copy URL" size="icon-sm" onClick={() => void navigator.clipboard.writeText(previewUrl(p.port)).then(() => toast.success("Copied"))}>
                  <Copy />
                </IconButton>
                <IconButton label="Open in system browser" size="icon-sm" onClick={() => window.open(previewUrl(p.port), "_blank", "noopener,noreferrer")}>
                  <ExternalLink />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}
