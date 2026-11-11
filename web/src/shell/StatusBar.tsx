import { ArrowDownUp, GitBranch, Terminal } from "lucide-react";
import { useUi } from "@/lib/store";
import { useGitStatus } from "@/lib/queries";
import { useWorkspace } from "@/lib/workspace";
import { useUpdate } from "@/lib/updates";
import { updateChip } from "@/lib/updates-logic";
import { openSettingsPage } from "@/features/settings/commands";
import { CodegraphButton } from "@/features/codegraph/CodegraphButton";

export function StatusBar() {
  const { root } = useWorkspace();
  const git = useGitStatus(root);
  const { setActivity, toggleBottom, bottomOpen } = useUi();
  const { state: update } = useUpdate();
  const chip = update ? updateChip(update) : null;
  const cell = "flex h-full items-center gap-1.5 px-2 outline-none transition-colors hover:bg-hover";

  return (
    <footer className="flex h-6 shrink-0 items-stretch justify-between border-t border-line bg-chrome font-mono text-[11px] text-fg-muted">
      <div className="flex items-stretch">
        <button onClick={() => setActivity("git")} className={cell}>
          <GitBranch className="size-3 text-accent" />
          {git.data?.branch ?? (git.data?.detached ? "detached" : "no repo")}
          {git.data && git.data.ahead + git.data.behind > 0 && (
            <span className="flex items-center gap-0.5 text-fg-faint">
              <ArrowDownUp className="size-3" />
              {git.data.ahead}↑ {git.data.behind}↓
            </span>
          )}
        </button>
        {git.data && git.data.files.length > 0 && (
          <button onClick={() => setActivity("git")} className={cell}>
            {git.data.files.length} change{git.data.files.length === 1 ? "" : "s"}
          </button>
        )}
        {git.data?.operation && <span className={`${cell} text-amber`}>{git.data.operation} in progress</span>}
        <CodegraphButton />
      </div>
      <div className="flex items-stretch">
        {update && (
          <button onClick={() => openSettingsPage("about")} className={`${cell} ${chip ? "text-fg" : ""}`} title={chip ?? "About TreeBoss and updates"}>
            {chip ?? `v${update.version}`}
          </button>
        )}
        <button onClick={toggleBottom} className={`${cell} ${bottomOpen ? "text-fg" : ""}`}>
          <Terminal className="size-3" /> Terminal
        </button>
      </div>
    </footer>
  );
}
