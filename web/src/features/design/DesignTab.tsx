import { useState } from "react";
import { AlertTriangle, BookmarkPlus, Check, Code2, Columns3, Eye, FileText, Globe, Library, Palette, Plug, RefreshCw, Settings2, Sparkles, Wand2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { ask, confirm } from "@/components/ui/dialogs";
import { Dialog, DropdownMenu } from "@/components/ui/overlay";
import { Badge, Empty, Skeleton, Spinner } from "@/components/ui/misc";
import { Markdown } from "@/features/agent/Markdown";
import { openSettingsPage } from "@/features/settings/commands";
import { useUi } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { useDesign, useDesignActions, useSystems } from "./data";
import { firstFamily, type DesignState, type SystemView } from "./logic";
import { composeDesign } from "./composer";
import { ColorStrip, TokenPanel } from "./Swatches";

/** The library as cards to pick from. */
function SystemCards({ systems, current, busy, onPick }: { systems: SystemView[]; current: string | null; busy: string | null; onPick: (s: SystemView) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
      {systems.map((s) => {
        const sans = s.summary.fonts.find((f) => f.name === "--font-display") ?? s.summary.fonts[0];
        return (
          <button key={s.id} type="button" data-design-system={s.id} disabled={!!busy} onClick={() => onPick(s)} className={cn("group flex flex-col gap-2 rounded-xl border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60", current === s.id ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong hover:bg-hover/40")}>
            <ColorStrip summary={s.summary} />
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold" style={sans ? { fontFamily: sans.value } : undefined}>
                {s.name}
              </span>
              {current === s.id && <Check className="size-3.5 shrink-0 text-accent" />}
              {busy === s.id && <Spinner className="size-3.5" />}
            </div>
            <p className="line-clamp-3 text-[11.5px] leading-snug text-fg-muted">{s.description || "No description."}</p>
            {sans && <span className="truncate font-mono text-[10.5px] text-fg-faint">{firstFamily(sans.value)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The directions a brainstorm turn wrote (design/directions.html), shown so the user can compare them and
 * answer in the session. The page is agent-written content: it renders in a fully sandboxed iframe (no
 * scripts, an opaque origin), and inherits this app's CSP, so web fonts fall back to local ones.
 */
function DirectionsPanel({ directions, onOpenFile, className }: { directions: DesignState["directions"]; onOpenFile: () => void; className?: string }) {
  return (
    <section className={cn("flex flex-col overflow-hidden rounded-xl border border-accent/40", className)} data-design-directions>
      <div className="flex items-center gap-2 border-b border-line bg-accent-soft/60 px-3 py-2">
        <Columns3 className="size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold">Directions to choose from</div>
          <div className="text-[11px] text-fg-muted">Answer in the agent session with a letter and any changes (“B, but warmer”). The agent then writes DESIGN.md and tokens.css and removes this page.</div>
        </div>
        <button type="button" onClick={onOpenFile} className="shrink-0 rounded px-1 font-mono text-[10.5px] text-fg-faint outline-none hover:bg-hover hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-accent/40">
          {directions.path}
        </button>
      </div>
      {directions.html !== null ? (
        <iframe title="Design directions" sandbox="" srcDoc={directions.html} className="h-[560px] w-full bg-white" referrerPolicy="no-referrer" />
      ) : (
        <p className="p-3 text-[12px] text-fg-muted">{directions.tooLarge ? "The page is too large to preview here; open the file instead." : "No page yet."}</p>
      )}
      <div className="border-t border-line px-3 py-1 text-[10.5px] text-fg-faint">Preview without scripts or web fonts; type samples use the fallback fonts installed here.</div>
    </section>
  );
}

/** The project's design system: DESIGN.md rendered, its tokens as swatches, and the agent work around it. */
export function DesignTab() {
  const { root } = useWorkspace();
  const openTab = useUi((s) => s.openTab);
  const q = useDesign(root);
  const systems = useSystems();
  const actions = useDesignActions(root);
  const [picking, setPicking] = useState(false);
  const state = q.data;
  const list = systems.data?.systems ?? [];
  const busy = actions.apply.isPending ? (actions.apply.variables?.system ?? null) : null;

  const openFile = (p: string) => openTab({ kind: "file", root, path: p, title: p.split("/").pop() ?? p });

  const apply = async (s: SystemView) => {
    if (state?.exists) {
      if (state.matches === s.id) return setPicking(false);
      const ok = await confirm({ title: `Replace this project's design system with "${s.name}"?`, description: "DESIGN.md and design/tokens.css are overwritten. Your current files stay in git history if they were committed.", confirmLabel: "Replace", danger: true });
      if (!ok) return;
    }
    actions.apply.mutate({ system: s.id, overwrite: !!state?.exists }, { onSuccess: () => setPicking(false) });
  };

  const saveToLibrary = async () => {
    const name = await ask({ title: "Save to the library", description: "Copies DESIGN.md and design/tokens.css into your design system library, so New app can start other projects from it.", label: "Name", initial: state?.title?.replace(/\s+design system$/i, "") ?? "", confirmLabel: "Save", validate: (v) => (v.trim() ? null : "Give it a name.") });
    if (name?.trim()) actions.save.mutate({ name: name.trim() });
  };

  let body: React.ReactNode;
  if (q.isLoading) {
    body = (
      <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-6 p-6">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    );
  } else if (q.error && !state) {
    body = <Empty icon={<AlertTriangle />} title="Could not read the design system" hint={q.error instanceof Error ? q.error.message : undefined} action={<Button onClick={() => void q.refetch()}>Try again</Button>} />;
  } else if (state && !state.exists) {
    body = (
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8" data-design-empty>
        {state.directions.exists && <DirectionsPanel directions={state.directions} onOpenFile={() => openFile(state.directions.path)} />}
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Palette className="size-5" />
          </span>
          <h3 className="text-[15px] font-semibold">No design system yet</h3>
          <p className="max-w-lg text-[12.5px] leading-relaxed text-fg-muted">
            A design system is <span className="font-mono">DESIGN.md</span> (the contract in words) and <span className="font-mono">design/tokens.css</span> (the values). Agents are told to read it before any UI work, so screens stop inventing their own colors and spacing. Nothing is written until you choose.
          </p>
        </div>
        <section>
          <div className="mb-2 flex items-center gap-2">
            <Library className="size-3.5 text-fg-muted" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Start from the library</span>
            <span className="flex-1" />
            <button type="button" onClick={() => openSettingsPage("design-systems")} className="text-[11.5px] text-fg-faint underline-offset-2 outline-none hover:text-fg-muted hover:underline focus-visible:underline">
              Manage library
            </button>
          </div>
          {systems.isLoading ? <Skeleton className="h-36" /> : <SystemCards systems={list} current={null} busy={busy} onPick={(s) => void apply(s)} />}
        </section>
        <section>
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="size-3.5 text-fg-muted" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Or generate one with an agent</span>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {(
              [
                ["brief", <Wand2 key="b" />, "From a brief", "Describe the product and its feel."],
                ["url", <Globe key="u" />, "From a reference site", "An original system with that site's feel."],
                ["codebase", <Code2 key="c" />, "From this code", "Write down what the UI already implies."],
              ] as const
            ).map(([kind, icon, label, hint]) => (
              <button key={kind} type="button" data-design-generate={kind} onClick={() => composeDesign(kind)} className="flex items-start gap-2.5 rounded-xl border border-line p-3 text-left outline-none transition-colors hover:border-line-strong hover:bg-hover/40 focus-visible:ring-2 focus-visible:ring-accent/40 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-accent">
                {icon}
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{label}</span>
                  <span className="block text-[11.5px] leading-snug text-fg-muted">{hint}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  } else if (state) {
    body = (
      <div className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-line p-4">
          {state.tokens.summary ? (
            <TokenPanel summary={state.tokens.summary} path={state.tokens.path} />
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-amber/50 p-3 text-[12px] text-fg-muted" data-design-no-tokens>
              <span className="flex items-center gap-1.5 font-medium text-fg">
                <AlertTriangle className="size-3.5 text-amber" /> No {state.tokens.path}
              </span>
              DESIGN.md describes the system but there are no token values for components to use. Regenerate from the existing DESIGN.md, or apply one from the library.
              <Button size="sm" onClick={() => composeDesign("brief")}>
                <Sparkles /> Generate
              </Button>
            </div>
          )}
        </aside>
        <div className="min-h-0 overflow-y-auto">
          {state.directions.exists && <DirectionsPanel directions={state.directions} onOpenFile={() => openFile(state.directions.path)} className="mx-6 mt-5" />}
          <article className="mx-auto max-w-3xl px-8 py-6" data-design-doc>
            <Markdown text={state.text ?? ""} />
          </article>
        </div>
      </div>
    );
  }

  return (
    <div data-design-tab className="relative flex h-full min-w-0 flex-col bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        <Palette className="size-4 shrink-0 text-accent" />
        <h2 className="truncate text-[13px] font-semibold text-fg">{state?.title ?? "Design"}</h2>
        {state?.exists && (
          <button type="button" onClick={() => openFile(state.path)} title="Open the file" className="truncate rounded px-1 font-mono text-[10.5px] text-fg-faint outline-none hover:bg-hover hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-accent/40">
            {state.path}
          </button>
        )}
        {state?.matches && <Badge tone="accent">library: {state.matches}</Badge>}
        {state?.exists && !state.agentRule && (
          <button type="button" data-design-add-rule onClick={() => actions.rule.mutate()} disabled={actions.rule.isPending} className="flex shrink-0 items-center gap-1 rounded px-1 text-[11px] text-amber outline-none hover:underline focus-visible:underline" title="Add a rule to AGENTS.md (and CLAUDE.md) so every agent reads DESIGN.md before UI work">
            <AlertTriangle className="size-3" /> Agents are not told about it. Add the rule
          </button>
        )}
        <span className="flex-1" />
        {state?.exists && (
          <>
            <IconButton label="Reload from the files" size="icon-sm" onClick={() => void q.refetch()}>
              <RefreshCw className={cn(q.isFetching && "animate-spin")} />
            </IconButton>
            <DropdownMenu
              align="end"
              trigger={
                <IconButton label="Open a file" size="icon-sm">
                  <FileText />
                </IconButton>
              }
              entries={[
                { label: state.path, onSelect: () => openFile(state.path) },
                { label: state.tokens.path, disabled: !state.tokens.exists, onSelect: () => openFile(state.tokens.path) },
              ]}
            />
            <IconButton label="Save to the library" size="icon-sm" onClick={() => void saveToLibrary()} disabled={actions.save.isPending}>
              <BookmarkPlus />
            </IconButton>
            <Button size="sm" variant="ghost" onClick={() => setPicking(true)} data-design-replace>
              <Library /> Library
            </Button>
            <Button size="sm" variant="ghost" onClick={() => composeDesign("brief")} data-design-regenerate>
              <Sparkles /> Generate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => composeDesign("wire")} data-design-wire title="Import the tokens into the app's styles and map them into its styling setup">
              <Plug /> Wire tokens
            </Button>
            <Button size="sm" variant="primary" onClick={() => composeDesign("review")} data-design-review title="Compare the UI with DESIGN.md and fix the clear-cut violations">
              <Eye /> Review UI
            </Button>
          </>
        )}
        {state && !state.exists && (
          <IconButton label="Design system library" size="icon-sm" onClick={() => openSettingsPage("design-systems")}>
            <Settings2 />
          </IconButton>
        )}
      </header>
      <div className="relative min-h-0 flex-1 overflow-y-auto">{body}</div>
      <Dialog open={picking} onOpenChange={setPicking} width={760} title="Replace from the library" description="Pick a system to write over this project's DESIGN.md and design/tokens.css. The current files are overwritten.">
        <div className="max-h-[60vh] overflow-y-auto p-0.5">
          <SystemCards systems={list} current={state?.matches ?? null} busy={busy} onPick={(s) => void apply(s)} />
        </div>
      </Dialog>
    </div>
  );
}
