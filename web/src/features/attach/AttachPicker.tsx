/**
 * One attach picker for the composer: specs, plans and docs in a single list (shown from its "+" menu), one row of chips.
 *
 * Before a session exists the choice is held by the composer and sent with the first message. Once it
 * exists, attaching and detaching go to the daemon, which delivers one block with the next turn.
 */
import { useMemo, type ReactNode } from "react";
import { BookMarked, Check, FileText, Gavel, ListChecks, ScrollText, X } from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import { useUi } from "@/lib/store";
import type { SessionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Empty } from "@/components/ui/misc";
import { CONSTITUTION_PATH } from "@/features/specs/logic";
import { FRESHNESS_LABEL, freshnessColor } from "@/features/docs/logic";
import { useAttachEstimate, useAttachmentActions, useCandidates, useSessionAttachments } from "./data";
import { type AttachItem, type AttachKind, type AttachMode, GROUPS, guessKind, isFreshness, KIND_LABEL, labelFor, compact, costTone, summarize } from "./logic";

export interface Attachments {
  items: AttachItem[];
  has: (path: string) => boolean;
  add: (path: string, mode?: AttachMode, kind?: AttachKind) => void;
  remove: (path: string) => void;
  setMode: (path: string, mode: AttachMode) => void;
  busy: boolean;
}

export function useAttachments(session: SessionView | null, pending: AttachItem[], setPending: (x: AttachItem[]) => void): Attachments {
  const q = useSessionAttachments(session?.id ?? null);
  const { attach, detach } = useAttachmentActions(session?.id ?? null);
  const items: AttachItem[] = session ? (q.data?.attached ?? []).map((a) => ({ path: a.path, mode: a.mode, kind: a.kind })) : pending;
  return {
    items,
    has: (path) => items.some((i) => i.path === path),
    add: (path, mode = "ref", kind) => (session ? attach.mutate({ path, mode }) : setPending([...pending.filter((p) => p.path !== path), { path, mode, kind: kind ?? guessKind(path) }])),
    remove: (path) => (session ? detach.mutate(path) : setPending(pending.filter((p) => p.path !== path))),
    setMode: (path, mode) => (session ? attach.mutate({ path, mode }) : setPending(pending.map((p) => (p.path === path ? { ...p, mode } : p)))),
    busy: attach.isPending || detach.isPending,
  };
}

const TONE: Record<AttachKind, { chip: string; soft: string; fg: string }> = {
  spec: { chip: "border-accent/25 bg-accent-soft text-accent", soft: "text-accent/70 hover:bg-accent/15 hover:text-accent", fg: "text-accent" },
  plan: { chip: "border-green/25 bg-green/10 text-green", soft: "text-green/70 hover:bg-green/15 hover:text-green", fg: "text-green" },
  doc: { chip: "border-blue/25 bg-blue/10 text-blue", soft: "text-blue/70 hover:bg-blue/15 hover:text-blue", fg: "text-blue" },
};

function iconOf(kind: AttachKind, path: string) {
  if (path === CONSTITUTION_PATH) return BookMarked;
  if (kind === "plan") return ListChecks;
  if (kind === "doc" && /\/decisions\//.test(path)) return Gavel;
  return FileText;
}

function Cost({ path, mode, className }: { path: string; mode: AttachMode; className?: string }) {
  const { root } = useWorkspace();
  const e = useAttachEstimate(root, path, mode);
  if (!e.data) return null;
  const tone = costTone(e.data.tokens);
  return (
    <span title={`About ${e.data.tokens.toLocaleString()} tokens added to the first turn${e.data.truncated ? " (cut at the size cap)" : ""}`} className={cn("font-mono text-[10.5px] tabular-nums", tone === "high" ? "text-red" : tone === "warn" ? "text-amber" : "text-fg-faint", className)}>
      ~{compact(e.data.tokens)}
      {e.data.truncated ? "+" : ""}
    </span>
  );
}

function ModeToggle({ mode, onChange }: { mode: AttachMode; onChange: (m: AttachMode) => void }) {
  return (
    <span className="inline-flex overflow-hidden rounded border border-line text-[10px]" role="group" aria-label="How to attach">
      {(["ref", "inline"] as const).map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} onClick={() => onChange(m)} title={m === "ref" ? "A short pointer: the agent reads the files when it needs them" : "Paste the files into the prompt (costs more tokens every new session)"} className={cn("px-1.5 py-px outline-none transition-colors", mode === m ? "bg-accent-soft text-accent" : "text-fg-faint hover:bg-hover")}>
          {m === "ref" ? "pointer" : "paste"}
        </button>
      ))}
    </span>
  );
}

/** The picker's content: one list for specs, plans and docs. Mounted by the composer's "+" menu, so it fetches only while open. */
export function AttachPanel({ att }: { att: Attachments }) {
  const { root } = useWorkspace();
  const setActivity = useUi((s) => s.setActivity);
  const cands = useCandidates(root, true);
  const n = att.items.length;
  const sum = summarize(att.items);
  const empty = cands.data && !cands.data.specs.length && !cands.data.plans.length && !cands.data.docs.length;
  return (
    <div className="flex flex-col" data-attach-panel>
      <div className="border-b border-line px-3 py-2">
        <div className="text-[12.5px] font-semibold">Attach</div>
        <p className="text-[11.5px] leading-snug text-fg-muted">The agent gets a short pointer to each and reads the files when it needs them. Paste mode puts the text in the prompt.</p>
        {n > 0 && (
          <p className="mt-1 text-[10.5px] text-fg-faint">
            {[sum.byKind.spec && `${sum.byKind.spec} spec${sum.byKind.spec === 1 ? "" : "s"}`, sum.byKind.plan && `${sum.byKind.plan} plan${sum.byKind.plan === 1 ? "" : "s"}`, sum.byKind.doc && `${sum.byKind.doc} doc${sum.byKind.doc === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
      {cands.isLoading ? (
        <div className="px-3 py-6 text-center text-[12px] text-fg-faint">Looking…</div>
      ) : empty ? (
        <Empty icon={<ScrollText />} title="Nothing to attach yet" hint="Write specs under Specs, plans in plan mode, docs under Docs." className="py-6" action={<button className="text-xs text-accent hover:underline" onClick={() => setActivity("specs")}>Open specs</button>} />
      ) : (
        <div className="max-h-[320px] overflow-y-auto p-1">
          {GROUPS.map(({ kind, key }) => {
            const list = cands.data?.[key] ?? [];
            if (!list.length) return null;
            return (
              <section key={kind} data-attach-group={kind}>
                <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">{KIND_LABEL[kind]}</div>
                <ul>
                  {list.map((c) => {
                    const on = att.has(c.path);
                    const item = att.items.find((i) => i.path === c.path);
                    const Icon = iconOf(kind, c.path);
                    return (
                      <li key={c.path} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
                        <button type="button" role="checkbox" aria-checked={on} aria-label={`${on ? "Detach" : "Attach"} ${c.title}`} data-attach-option={c.path} onClick={() => (on ? att.remove(c.path) : att.add(c.path, "ref", kind))} className={cn("flex size-4 shrink-0 items-center justify-center rounded border outline-none transition-colors", on ? "border-accent bg-accent text-accent-fg" : "border-line-strong hover:border-accent")}>
                          {on && <Check className="size-3" strokeWidth={3} />}
                        </button>
                        <Icon className="size-3.5 shrink-0 text-fg-muted" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px]">{c.title}</div>
                          <div className="flex items-center gap-1.5 truncate text-[10.5px] text-fg-faint">
                            {kind === "doc" && isFreshness(c.sub) ? (
                              <>
                                <span style={{ background: freshnessColor(c.sub) }} className={cn("size-[6px] rounded-full", (c.sub === "unmanaged" || c.sub === "unknown") && "opacity-50")} />
                                {FRESHNESS_LABEL[c.sub]}
                              </>
                            ) : (
                              c.sub
                            )}
                          </div>
                        </div>
                        {on && item ? <ModeToggle mode={item.mode} onChange={(m) => att.setMode(c.path, m)} /> : null}
                        {on && item ? <Cost path={c.path} mode={item.mode} /> : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** What is attached as chips, with what each costs and an x to take it off. Renders nothing when there is nothing. */
export function AttachChips({ att, extra }: { att: Attachments; extra?: ReactNode }) {
  const setActivity = useUi((s) => s.setActivity);
  const { root } = useWorkspace();
  const cands = useCandidates(root, att.items.length > 0, true);
  const titles = useMemo(() => new Map([...(cands.data?.specs ?? []), ...(cands.data?.plans ?? []), ...(cands.data?.docs ?? [])].map((c) => [c.path, c.title])), [cands.data]);
  if (att.items.length === 0 && !extra) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pb-1" data-attach-chips>
      {extra}
      {att.items.map((i) => {
        const kind = i.kind ?? guessKind(i.path);
        const Icon = iconOf(kind, i.path);
        const tone = TONE[kind];
        const label = labelFor(i.path, kind, titles);
        return (
          <span key={i.path} data-attach-chip={i.path} data-kind={kind} className={cn("group inline-flex h-5 max-w-[220px] items-center gap-1 rounded-md border pl-1.5 pr-0.5 text-[11px] animate-pop", tone.chip)}>
            <button type="button" onClick={() => setActivity(kind === "doc" ? "docs" : "specs")} className="flex min-w-0 items-center gap-1 outline-none" title={`${i.path} (${i.mode === "ref" ? "pointer" : "pasted"})`}>
              <Icon className="size-3 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
            <Cost path={i.path} mode={i.mode} className="opacity-70" />
            <button type="button" aria-label={`Detach ${label}`} onClick={() => att.remove(i.path)} className={cn("flex size-4 items-center justify-center rounded outline-none focus-visible:bg-current/10", tone.soft)}>
              <X className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}


