import { FolderGit2 } from "lucide-react";
import { useUi } from "@/lib/store";
import { basename } from "@/lib/utils";
import { Section } from "@/components/ui/misc";
import { useWorktrees } from "./queries";

/** The extra checkouts of this repo: mostly the heads' isolated worktrees. */
export function Worktrees({ root, currentDir }: { root: string; currentDir: string | undefined }) {
  const wt = useWorktrees(root);
  const openTab = useUi((s) => s.openTab);
  const others = (wt.data ?? []).filter((w) => w.path !== currentDir && !w.bare);
  if (others.length === 0) return null;
  return (
    <Section title="Worktrees" count={others.length} defaultOpen={false}>
      <div className="pb-1">
        {others.map((w) => (
          <button
            key={w.path}
            disabled={!w.head}
            onClick={() => w.head && openTab({ kind: "commit", root, sha: w.head, title: w.head.slice(0, 7) })}
            title={`${w.path}\nClick to open its tip commit`}
            className="flex h-[26px] w-full items-center gap-2 px-2 text-left text-[12.5px] outline-none hover:bg-hover focus-visible:bg-hover"
          >
            <FolderGit2 className="size-3.5 shrink-0 text-violet" />
            <span className="min-w-0 flex-1 truncate">{w.branch ?? "(detached)"}</span>
            <span className="max-w-[40%] truncate font-mono text-[10.5px] text-fg-faint">{basename(w.path)}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}
