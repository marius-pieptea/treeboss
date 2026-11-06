import { ChevronRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/form";
import { Badge } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { Agent, Skill } from "@/lib/types";
import { agentsUsingSkill } from "./agents-logic";
import { LazyFileCount } from "./skills-files";
import { packActions, packCountText, safeHttpUrl, type PackSection } from "./skills-logic";

/** One skill in the Skills list: its name, what it does and its switch. A pack skill shows its pack's badge in place of "built-in". */
export function SkillRow({ s, index, selected, agents, badge, onSelect, onToggle }: {
  s: Skill;
  index: number;
  selected: boolean;
  agents: Agent[];
  /** The title of the pack the skill ships in, when it is a pack skill. */
  badge?: string;
  onSelect: (name: string) => void;
  onToggle: (on: boolean) => void;
}) {
  const users = agentsUsingSkill(agents, s.name);
  return (
    <div style={{ animationDelay: `${Math.min(index, 12) * 20}ms` }} className="animate-slide-right">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onSelect(s.name)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(s.name))}
        className={cn("group flex cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2 outline-none transition-colors focus-visible:bg-hover", selected ? "bg-active" : "hover:bg-hover", !s.enabled && "opacity-55")}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[12.5px] font-medium">{s.name}</span>
            {badge ? (
              <Badge className="shrink-0" title={`Ships with trb in the ${badge} pack`}>
                {badge}
              </Badge>
            ) : (
              s.builtin && <span className="shrink-0 text-[10px] text-fg-faint">built-in</span>
            )}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-fg-muted">{s.description || "No description"}</div>
          <div className="mt-1 min-h-3">
            <LazyFileCount name={s.name} />
          </div>
          {users.length ? (
            <div className="mt-1 truncate font-mono text-[10.5px] text-fg-faint" title={`Assigned to: ${users.map((u) => u.title).join(", ")}`}>
              used by: {users.map((u) => u.name).join(", ")}
            </div>
          ) : null}
        </div>
        <div onClick={(e) => e.stopPropagation()} className="pt-0.5">
          <Switch checked={s.enabled} onChange={onToggle} label={`${s.name} enabled`} />
        </div>
      </div>
    </div>
  );
}

/**
 * A pack's group on the Skills page: its name, version, license, author and upstream, its counts, the two buttons that
 * act on the whole pack, and its installed skills under that. Collapsed by default; a search that finds one of its skills
 * opens it (SkillsPage).
 */
export function PackGroup({ section: p, open, busy, selected, agents, onOpenChange, onSelect, onToggle, onToggleAll }: {
  section: PackSection<Skill>;
  open: boolean;
  /** A change to this pack is in flight: both buttons wait for it. */
  busy: boolean;
  selected: string | null;
  agents: Agent[];
  onOpenChange: (open: boolean) => void;
  onSelect: (name: string) => void;
  onToggle: (name: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
}) {
  const { enable, disable } = packActions(p);
  const upstream = safeHttpUrl(p.upstream);
  const bodyId = `skill-pack-${p.id}`;
  return (
    <section className="mt-2 border-t border-line pt-2">
      <div className="px-2">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => onOpenChange(!open)} className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left outline-none hover:bg-hover focus-visible:bg-hover">
          <ChevronRight className={cn("size-3 shrink-0 text-fg-muted transition-transform duration-150", open && "rotate-90")} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{p.title}</span>
          <span className="shrink-0 font-mono text-[11px] text-fg-muted">{packCountText(p)}</span>
        </button>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-[11px] text-fg-muted">
          {p.version && <span className="font-mono">v{p.version}</span>}
          {p.license && <span className="font-mono">{p.license}</span>}
          {p.author && <span className="min-w-0 truncate">by {p.author}</span>}
          {upstream && (
            <a href={upstream} target="_blank" rel="noreferrer" title={upstream} className="inline-flex items-center gap-1 text-accent hover:underline">
              upstream <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2 pl-5 pt-1">
          <Button variant="subtle" size="xs" disabled={!enable || busy} onClick={() => onToggleAll(true)} title={`Turn on every installed ${p.title} skill`}>
            Enable all
          </Button>
          <Button variant="subtle" size="xs" disabled={!disable || busy} onClick={() => onToggleAll(false)} title={`Turn off every installed ${p.title} skill`}>
            Disable all
          </Button>
        </div>
      </div>
      <div className={cn("grid transition-[grid-template-rows] duration-200 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div id={bodyId} inert={!open} className="min-h-0 overflow-hidden">
          {p.installed === 0 ? (
            <div className="px-2.5 py-2 text-[11px] text-fg-muted">None of its skills is installed. Restore built-in skills brings them back.</div>
          ) : (
            p.skills.map((s, i) => <SkillRow key={s.name} s={s} index={i} selected={selected === s.name} agents={agents} badge={p.title} onSelect={onSelect} onToggle={(on) => onToggle(s.name, on)} />)
          )}
        </div>
      </div>
    </section>
  );
}
