/**
 * How the session is set up, as small chips inside the box (the same place attachments and a goal show): the agent,
 * the skills when they were narrowed, and the isolated worktree. For the next session they can be dropped with the x;
 * for one that is open they are read-only (an agent and the isolation are fixed once a session starts).
 */
import { BookOpen, GitBranch, UserRoundCog, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChipProps {
  attr: string;
  icon: React.ReactNode;
  label: string;
  title: string;
  onClear?: () => void;
  onOpen?: () => void;
}

function Chip({ attr, icon, label, title, onClear, onOpen }: ChipProps) {
  return (
    <span {...{ [attr]: "" }} title={title} className={cn("group inline-flex h-5 max-w-[200px] items-center gap-1 rounded-md border border-line bg-panel pl-1.5 text-[11px] text-fg-muted animate-pop", onClear ? "pr-0.5" : "pr-1.5")}>
      <button type="button" disabled={!onOpen} onClick={onOpen} className={cn("flex min-w-0 items-center gap-1 outline-none", onOpen ? "hover:text-fg" : "cursor-default")}>
        <span className="shrink-0 [&_svg]:size-3">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
      {onClear && (
        <button type="button" aria-label={`Remove: ${label}`} onClick={onClear} className="flex size-4 items-center justify-center rounded text-fg-faint outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

export interface SetupChipsProps {
  /** An open session's own, read-only. */
  fixed?: { agent: string | null; worktree: boolean };
  agent: string | null;
  skillsLabel: string | null;
  worktree: boolean;
  onAgent: () => void;
  onSkills: () => void;
  onClearAgent: () => void;
  onClearSkills: () => void;
  onClearWorktree: () => void;
}

/** Null when there is nothing to show, so an empty row takes no room. */
export function setupChips(p: SetupChipsProps): React.ReactNode {
  if (p.fixed) {
    if (!p.fixed.agent && !p.fixed.worktree) return null;
    return (
      <>
        {p.fixed.agent && <Chip attr="data-setup-agent" icon={<UserRoundCog />} label={p.fixed.agent} title={`Agent: ${p.fixed.agent}. Fixed once a session starts.`} />}
        {p.fixed.worktree && <Chip attr="data-setup-worktree" icon={<GitBranch />} label="worktree" title="This session edits an isolated worktree. Fixed once a session starts." />}
      </>
    );
  }
  if (!p.agent && !p.skillsLabel && !p.worktree) return null;
  return (
    <>
      {p.agent && <Chip attr="data-setup-agent" icon={<UserRoundCog />} label={p.agent} title={`Agent: ${p.agent}. Click to change.`} onOpen={p.onAgent} onClear={p.onClearAgent} />}
      {p.skillsLabel && <Chip attr="data-setup-skills" icon={<BookOpen />} label={p.skillsLabel} title="Skills for this session. Click to change." onOpen={p.onSkills} onClear={p.onClearSkills} />}
      {p.worktree && <Chip attr="data-setup-worktree" icon={<GitBranch />} label="worktree" title="The lead edits a separate branch checkout; your files stay untouched until you merge." onClear={p.onClearWorktree} />}
    </>
  );
}
