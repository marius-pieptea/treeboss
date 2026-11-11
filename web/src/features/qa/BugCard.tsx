import { useEffect, useRef } from "react";
import { ArrowUpRight, Check, Hammer, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/misc";
import { openSession } from "@/features/agent/agent-commands";
import { partUrl } from "@/features/evidence/data";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { BoardBug } from "./api";
import { BUG_TONE, BUG_WORD, bugOffers } from "./logic";
import { CellView } from "./Status";

const IMPACT_TONE = { high: "red", medium: "amber", low: "neutral" } as const;

/** A bug logged from the browser, by a person or a QA agent: the page it was seen on, a thumbnail of what was captured, and what can be done with it. */
export function BugCard({
  root,
  bug,
  busy,
  pending,
  focused,
  features,
  onFix,
  onStatus,
  onFeature,
}: {
  root: string;
  bug: BoardBug;
  /** A pipeline is in flight: a fix would be refused. */
  busy: boolean;
  pending: boolean;
  focused?: boolean;
  /** Given, the card offers to move the bug to a feature. */
  features?: Array<{ id: string; title: string }>;
  onFix: (id: string) => void;
  onStatus: (id: string, status: "new" | "dismissed" | "shipped") => void;
  onFeature?: (id: string, feature: string | null) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  const openTab = useUi((s) => s.openTab);
  const offers = bugOffers(bug.state);
  const closed = bug.state === "fixed" || bug.state === "dismissed";
  const shot = bug.capture && bug.shot !== "none" ? partUrl(root, bug.capture, "screenshot.png") : null;
  return (
    <article ref={ref} data-bug={bug.id} data-bug-state={bug.state} className={cn("flex gap-3 rounded-lg border border-line bg-raised p-3", closed && "opacity-60", focused && "border-line-strong bg-accent-soft")}>
      {shot && <img src={shot} alt={`Screenshot for ${bug.title}`} loading="lazy" className="h-16 w-24 shrink-0 rounded-md border border-line bg-panel object-cover object-top" />}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <header className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 font-medium leading-snug">{bug.title}</h3>
          <CellView cell={{ tone: BUG_TONE[bug.state], word: BUG_WORD[bug.state] }} className="shrink-0" />
        </header>
        <div className="flex flex-wrap items-center gap-1">
          <Badge title="Kind of bug">{bug.kind}</Badge>
          <Badge tone={IMPACT_TONE[bug.impact]} title="Impact">
            {bug.impact}
          </Badge>
          {bug.byAgent && <Badge title="Logged by a QA agent while it used the app">agent</Badge>}
          {bug.shot === "rerender" && <Badge title="The screenshot was re-rendered from the captured page, not taken from the screen">re-render</Badge>}
        </div>
        {bug.url && (
          <button type="button" onClick={() => openTab({ kind: "browser", url: bug.url, title: bug.url })} title="Open in the preview browser" className="max-w-full self-start truncate rounded-sm px-1 font-mono text-label text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/60">
            {bug.url}
          </button>
        )}
        {bug.summary && <p className="line-clamp-2 text-xs leading-snug text-fg-muted">{bug.summary}</p>}
        {bug.problem && <p className="text-xs text-amber">{bug.problem}</p>}
        <footer className="flex flex-wrap items-center gap-1 pt-1">
          {offers.fix && (
            <Button size="xs" variant="subtle" disabled={busy || pending} onClick={() => onFix(bug.id)} title={busy ? "A pipeline is running. Wait for it or stop it." : "Start a session that fixes this bug"}>
              <Hammer /> Fix
            </Button>
          )}
          {bug.fixSession && (
            <Button size="xs" variant="ghost" onClick={() => openSession(bug.fixSession!)}>
              <ArrowUpRight /> Fix session
            </Button>
          )}
          {features && onFeature && (
            <Select
              size="sm"
              className="h-6 w-40"
              aria-label="Feature of this bug"
              value={bug.feature ?? ""}
              onChange={(v) => onFeature(bug.id, v || null)}
              placeholder="No feature"
              options={[{ value: "", label: "No feature" }, ...features.map((f) => ({ value: f.id, label: f.title }))]}
            />
          )}
          <div className="flex-1" />
          {offers.reopen && (
            <Button size="xs" variant="ghost" disabled={pending} onClick={() => onStatus(bug.id, "new")}>
              <Undo2 /> Reopen
            </Button>
          )}
          {offers.close && (
            <>
              <Button size="xs" variant="ghost" disabled={pending} onClick={() => onStatus(bug.id, "shipped")}>
                <Check /> Fixed
              </Button>
              <Button size="xs" variant="ghost" disabled={pending} onClick={() => onStatus(bug.id, "dismissed")}>
                <X /> Dismiss
              </Button>
            </>
          )}
        </footer>
      </div>
    </article>
  );
}
