/**
 * The "+" at the left of the composer's footer: everything you add to a message or a session in one menu.
 * Attach (specs, plans, docs: one picker), Set a goal, Mention a file. Arrow keys move, Enter chooses, Esc closes.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AtSign, BookOpen, ChevronLeft, ChevronRight, FilePlus, GitBranch, Palette, Paperclip, Plus, Target, UserRoundCog } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover } from "@/components/ui/overlay";
import { AttachPanel, type Attachments } from "@/features/attach/AttachPicker";

function Item({ icon, label, hint, onClick, attr, badge, disabled }: { icon: ReactNode; label: string; hint?: string; onClick: () => void; attr: string; badge?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" {...{ [attr]: "" }} disabled={disabled} onClick={onClick} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] outline-none transition-colors hover:bg-active focus-visible:bg-active disabled:opacity-40 [&_svg]:size-3.5 [&_svg]:shrink-0">
      <span className="text-fg-muted">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {badge}
      {hint && <span className="text-[10.5px] text-fg-faint">{hint}</span>}
    </button>
  );
}

/** How the next session is set up: only offered before a session exists (an agent and isolation are fixed once it starts). */
export interface PlusSetup {
  agent: string | null;
  skills: string;
  worktree: boolean;
  onAgent: () => void;
  onSkills: () => void;
  onWorktree: () => void;
}

export function PlusMenu({ att, closed, goalActive, onGoal, designActive, onDesign, onMention, onPickFiles, setup }: { att: Attachments; closed: boolean; goalActive: boolean; onGoal: () => void; designActive?: boolean; onDesign?: () => void; onMention: () => void; onPickFiles?: () => void; setup?: PlusSetup }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "attach">("menu");
  const list = useRef<HTMLDivElement>(null);
  const n = att.items.length;

  // Every open starts at the menu, with the first item focused so the keyboard works at once.
  useEffect(() => {
    if (!open) return;
    setView("menu");
  }, [open]);
  useEffect(() => {
    if (open && view === "menu") requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus());
  }, [open, view]);

  const move = (dir: 1 | -1) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + dir + items.length) % items.length]?.focus();
  };
  const choose = (fn: () => void) => () => {
    setOpen(false);
    // After the popover has returned focus, so a dialog or the box can take it.
    setTimeout(fn, 0);
  };

  return (
    <Popover
      side="top"
      align="start"
      width={view === "attach" ? 340 : 232}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" data-plus-menu disabled={closed} aria-label="Add: attach, goal, mention a file, agent, skills" title="Attach files, set a goal, mention a file" className={cn("relative flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover disabled:opacity-40", open && "bg-hover text-fg")}>
          <Plus className={cn("size-4 transition-transform duration-150", open && "rotate-45")} />
          {(n > 0 || goalActive) && <span data-plus-dot className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-accent" />}
        </button>
      }
    >
      {view === "menu" ? (
        <div
          ref={list}
          role="menu"
          aria-label="Add"
          className="flex flex-col"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            }
          }}
        >
          <Item attr="data-attach" icon={<Paperclip />} label="Attach specs, plans, docs" badge={n > 0 ? <span className="font-mono text-[11px] text-accent">{n}</span> : <ChevronRight className="text-fg-faint" />} onClick={() => setView("attach")} />
          {onPickFiles && <Item attr="data-attach-files" icon={<FilePlus />} label="Attach files…" hint="PDF, zip, text" onClick={choose(onPickFiles)} />}
          <Item attr="data-goal-open" icon={<Target />} label={goalActive ? "Edit the goal" : "Set a goal"} onClick={choose(onGoal)} />
          {onDesign && <Item attr="data-design-open" icon={<Palette />} label={designActive ? "Design turn (on)" : "Design system…"} hint="/design" onClick={choose(onDesign)} />}
          <Item attr="data-mention-open" icon={<AtSign />} label="Mention a file" hint="@" onClick={choose(onMention)} />
          {setup && (
            <>
              <div className="mx-2 my-1 h-px bg-line" />
              <Item attr="data-setup-open-agent" icon={<UserRoundCog />} label="Agent…" hint={setup.agent ?? undefined} onClick={choose(setup.onAgent)} />
              <Item attr="data-setup-open-skills" icon={<BookOpen />} label="Skills…" hint={setup.skills} onClick={choose(setup.onSkills)} />
              <Item attr="data-setup-open-worktree" icon={<GitBranch />} label="Isolated worktree" hint={setup.worktree ? "on" : "off"} onClick={choose(setup.onWorktree)} />
            </>
          )}
        </div>
      ) : (
        <div>
          <button type="button" onClick={() => setView("menu")} className="mb-1 flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-faint outline-none hover:bg-active hover:text-fg-muted focus-visible:bg-active">
            <ChevronLeft className="size-3.5" /> Add
          </button>
          <AttachPanel att={att} />
        </div>
      )}
    </Popover>
  );
}
