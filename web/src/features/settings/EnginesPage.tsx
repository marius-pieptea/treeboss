import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ChevronRight, Crown, FolderInput, History, ListTree, PackageOpen, RefreshCw, Wrench, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton, Spinner } from "@/components/ui/misc";
import { ModelPicker } from "@/components/ui/model-select";
import { useModels } from "@/lib/models";
import { ago, cn } from "@/lib/utils";
import { useDoctor, type DoctorEngine } from "./data";
import { EngineChip, ErrorNote, PageShell, engineTone } from "./shared";
import { EngineIcon } from "@/components/ui/engine-icon";

const WIRING: Record<DoctorEngine["mcp"], string> = {
  "config-file": "trb writes a private MCP config file outside your repo and hands it to the engine on the command line. For this engine trb's list is the whole tool surface, so a session's tools are the same every run.",
  "cli-override": "trb passes each MCP server as a command-line override, layered on top of the engine's own configuration. Servers you configured in the engine itself are still there.",
  "workspace-file": "trb writes an MCP config into the workspace for the length of a turn and puts back whatever was there before. The engine's own configuration still applies on top.",
  none: "trb's tools are not wired for this engine's one-shot mode, so it cannot reach MCP servers or the subagent tools.",
};

const BINARIES: Record<string, string> = { claude: "claude", codex: "codex", cursor: "cursor-agent (or cursor)", opencode: "opencode", agy: "agy", grok: "grok" };

/**
 * The engine's model list: asked of the CLI itself (claude has a built-in one), cached by the daemon. Closed until
 * opened, so a page visit does not start five CLIs. Clicking a model copies its id.
 */
function EngineModels({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const { catalog, isLoading } = useModels(open ? id : null);
  return (
    <div className="mt-3 border-t border-line pt-2.5">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1.5 text-left text-xs outline-none hover:text-fg">
        <ChevronRight className={cn("size-3.5 text-fg-faint transition-transform duration-150", open && "rotate-90")} />
        <ListTree className="size-3.5 text-fg-faint" />
        <span className="shrink-0 font-medium">Models</span>
        <span
          className="min-w-0 flex-1 truncate text-right text-fg-faint"
          title={catalog ? `${catalog.efforts.length ? `Effort levels: ${catalog.efforts.join(", ")}` : "No effort control"}` : undefined}
        >
          {catalog
            ? `${catalog.models.length.toLocaleString()} · ${catalog.source === "cli" ? "from the CLI" : "built-in"} · ${ago(catalog.fetchedAt) === "now" ? "just now" : `${ago(catalog.fetchedAt)} ago`}${catalog.efforts.length ? ` · ${catalog.efforts.length} efforts` : " · no effort control"}`
            : open && isLoading
              ? "loading…"
              : "click to load"}
        </span>
      </button>
      {open && (
        <div className="mt-2 animate-slide-up rounded-lg border border-line bg-raised/40 p-1.5">
          <ModelPicker
            engine={id}
            value=""
            onChange={() => {}}
            allowDefault={false}
            autoFocus={false}
            maxHeight={260}
            onPick={(m) => {
              void navigator.clipboard?.writeText(m.id);
              toast.success(`Copied ${m.id}`);
            }}
          />
        </div>
      )}
    </div>
  );
}

function EngineCard({ e, delay }: { e: DoctorEngine; delay: number }) {
  const tone = engineTone(e.id);
  return (
    <div style={{ animationDelay: `${delay}ms`, ["--tone" as string]: tone }} className={cn("animate-slide-up rounded-xl border bg-bg/40 p-4 transition-colors", e.installed ? "border-line hover:border-line-strong" : "border-dashed border-line opacity-80")}>
      <div className="flex items-center gap-2">
        <span className={cn("flex size-6 items-center justify-center rounded-md border border-line bg-raised", !e.installed && "opacity-50 grayscale")}>
          <EngineIcon engine={e.id} className="size-4" />
        </span>
        <h3 className="text-[14px] font-semibold">{e.label}</h3>
        <EngineChip id={e.id} icon={false} />
        <div className="flex-1" />
        {e.installed ? <Badge tone="green">installed</Badge> : <Badge tone="amber">not installed</Badge>}
      </div>

      {e.installed ? (
        <div className="mt-2 grid gap-0.5 font-mono text-[11px] text-fg-muted">
          <span className="truncate" title={e.bin ?? undefined}>{e.bin}</span>
          <span className="text-fg-faint">{e.version || "version unknown"}</span>
        </div>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-fg-muted">
          trb looks for <span className="font-mono text-fg">{BINARIES[e.id] ?? e.id}</span> on your PATH. Install it, sign in once from a terminal, then re-run the check.
        </p>
      )}

      <dl className="mt-3 grid gap-2.5 text-xs">
        <div className="flex gap-2">
          <Crown className={cn("mt-0.5 size-3.5 shrink-0", e.canLead ? "text-accent" : "text-fg-faint")} />
          <div>
            <dt className="font-medium">{e.canLead ? "Can lead a Hydra pair" : "Head only"}</dt>
            <dd className="mt-0.5 leading-relaxed text-fg-muted">{e.canLead ? "It can call the subagent tools to open heads, wait for them, review and merge their work." : "It works fine as a head, but it has no way to call the subagent tools, so it cannot lead."}</dd>
          </div>
        </div>
        <div className="flex gap-2">
          <Wrench className="mt-0.5 size-3.5 shrink-0 text-fg-faint" />
          <div>
            <dt className="font-medium">MCP servers</dt>
            <dd className="mt-0.5 leading-relaxed text-fg-muted">{WIRING[e.mcp]}</dd>
          </div>
        </div>
        <div className="flex gap-2">
          <FolderInput className="mt-0.5 size-3.5 shrink-0 text-fg-faint" />
          <div>
            <dt className="font-medium">Skills</dt>
            <dd className="mt-0.5 leading-relaxed text-fg-muted">{e.skills_dir ? <>Copied into <span className="font-mono text-fg">{e.skills_dir}</span> for each turn, and removed afterwards.</> : "This engine has no skills folder, so enabled skills are listed in the prompt instead."}</dd>
          </div>
        </div>
        <div className="flex gap-2">
          <History className="mt-0.5 size-3.5 shrink-0 text-fg-faint" />
          <div>
            <dt className="font-medium">Follow-ups</dt>
            <dd className="mt-0.5 leading-relaxed text-fg-muted">{e.resume ? "Resume the engine's own conversation, with its full context." : "Replay the previous answer into a fresh conversation."}</dd>
          </div>
        </div>
      </dl>
      {e.installed && <EngineModels id={e.id} />}
    </div>
  );
}

const ICON = {
  ok: <CheckCircle2 className="size-4 shrink-0 text-green" />,
  warn: <AlertTriangle className="size-4 shrink-0 text-amber" />,
  fail: <XCircle className="size-4 shrink-0 text-red" />,
};

export function EnginesPage() {
  const q = useDoctor();
  const d = q.data;
  const installed = d?.engines.filter((e) => e.installed).length ?? 0;
  const ordered = d ? [...d.engines].sort((a, b) => Number(b.installed) - Number(a.installed)) : [];
  return (
    <PageShell
      wide
      title="Engines"
      description="The coding CLIs trb can drive, on your own subscriptions. What each can do depends on how trb can reach it."
      actions={
        <Button variant="outline" size="md" onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? <Spinner /> : <RefreshCw />} Re-run checks
        </Button>
      }
    >
      {q.isLoading && (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      )}
      {q.error && <ErrorNote>{(q.error as Error).message}</ErrorNote>}
      {d && (
        <>
          <div className={cn("flex items-center gap-3 rounded-xl border px-4 py-3 animate-slide-up", d.status === "ok" ? "border-green/25 bg-green/5" : d.status === "warn" ? "border-amber/25 bg-amber/5" : "border-red/30 bg-red/5")}>
            {ICON[d.status]}
            <div className="text-[13px]">
              <span className="font-medium">{d.status === "ok" ? "Everything checks out" : d.status === "warn" ? "Working, with notes" : "Something needs fixing"}</span>
              <span className="text-fg-muted">
                {" "}
                · {installed} of {d.engines.length} engines installed · {d.counts.mcpEnabled} MCP server{d.counts.mcpEnabled === 1 ? "" : "s"} on · {d.counts.skillsEnabled} skill{d.counts.skillsEnabled === 1 ? "" : "s"} on
              </span>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {ordered.map((e, i) => (
              <EngineCard key={e.id} e={e} delay={i * 35} />
            ))}
          </div>

          <section aria-label="Checks" className="animate-slide-up">
            <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
              <PackageOpen className="size-3.5" /> Checks
            </h2>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {d.checks.map((c) => (
                <li key={c.id} className="flex items-start gap-2.5 px-3.5 py-2 text-[12.5px]">
                  {ICON[c.level]}
                  <span className={cn("min-w-0 flex-1 break-words font-mono text-[12px]", c.level === "ok" ? "text-fg-muted" : "text-fg")}>{c.text}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </PageShell>
  );
}
