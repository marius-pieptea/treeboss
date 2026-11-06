import { Bot, FilePlus2, GitBranch, Globe, Search, SquareTerminal } from "lucide-react";
import { openBrowserTab } from "@/features/browser/discover";
import { useUi } from "@/lib/store";
import { bus } from "@/lib/bus";
import { formatCombo, useGlow } from "@/lib/hooks";
import { Kbd } from "@/components/ui/misc";
import { Logo } from "./Logo";
import { useWorkspace } from "@/lib/workspace";

function Tile({ icon, title, hint, combo, onClick, delay }: { icon: React.ReactNode; title: string; hint: string; combo?: string; onClick: () => void; delay: number }) {
  const glow = useGlow();
  return (
    <button {...glow} onClick={onClick} style={{ animationDelay: `${delay}ms` }} className="glow-surface group animate-slide-up flex items-start gap-3 rounded-xl border border-line bg-panel/60 p-3.5 text-left outline-none transition-[border-color,transform] hover:border-line-strong focus-visible:border-accent/60 active:scale-[0.99]">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-accent transition-transform group-hover:scale-110 [&_svg]:size-4">{icon}</div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          {title}
          {combo && <Kbd>{combo}</Kbd>}
        </div>
        <div className="mt-0.5 text-xs text-fg-muted">{hint}</div>
      </div>
    </button>
  );
}

export function Welcome() {
  const { workspace } = useWorkspace();
  const { setActivity, setBottomTab, toggleBottom, bottomOpen } = useUi();
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklab,var(--accent)_7%,transparent),transparent)] p-8">
      <div className="w-full max-w-[560px]">
        <div className="mb-7 flex items-center gap-3 animate-slide-up">
          <Logo size={36} />
          <div className="min-w-0">
            <h1 className="text-[18px] font-semibold tracking-tight">{workspace.name}</h1>
            <p className="truncate font-mono text-[11px] text-fg-faint" title={workspace.path}>{workspace.path}</p>
          </div>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Tile delay={30} icon={<Bot />} title="Ask an agent" hint="Describe the change; pick a pair to lead heads." combo={formatCombo({ key: "i", mod: true })} onClick={() => bus.emit("focus-composer")} />
          <Tile delay={60} icon={<Search />} title="Go to file" hint="Fuzzy-find anything in the project." combo={formatCombo({ key: "p", mod: true })} onClick={() => bus.emit("open-quick-open")} />
          <Tile delay={90} icon={<GitBranch />} title="Source control" hint="Review changes, stage hunks, commit." combo={formatCombo({ key: "g", mod: true, shift: true })} onClick={() => setActivity("git")} />
          <Tile
            delay={120}
            icon={<SquareTerminal />}
            title="Terminal"
            hint="A real shell in the workspace."
            combo="Ctrl+`"
            onClick={() => {
              setBottomTab("terminal");
              if (!bottomOpen) toggleBottom();
            }}
          />
          <Tile delay={135} icon={<Globe />} title="Browser" hint="Preview your dev server, or watch an agent drive a page." onClick={() => openBrowserTab("preview")} />
          <Tile delay={150} icon={<FilePlus2 />} title="Browse files" hint="Open the explorer." combo={formatCombo({ key: "e", mod: true, shift: true })} onClick={() => setActivity("explorer")} />
        </div>
      </div>
    </div>
  );
}
