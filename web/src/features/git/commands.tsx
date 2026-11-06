/**
 * Git commands for the palette. Registered when this module loads, not when the sidebar mounts: the palette
 * must offer "Push" while the Explorer is showing, so nothing here may depend on a mounted component.
 */
import { ArrowDown, ArrowUp, Archive, GitBranch, GitCommitHorizontal, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { get, url } from "@/lib/api";
import { useCommandStore, type Command } from "@/lib/commands";
import { queryClient } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { confirm } from "@/components/ui/dialogs";
import type { GitStatus } from "@/lib/types";
import { gitActions } from "./actions";
import { promptNewBranch } from "./BranchPicker";
import { promptStash } from "./Stashes";
import { useGitUi } from "./ui";
import { qk } from "@/lib/queries";
import { toast } from "sonner";

const root = (): string | null => useUi.getState().current;

const status = async (r: string): Promise<GitStatus | null> => {
  try {
    return await queryClient.fetchQuery({ queryKey: qk.gitStatus(r), queryFn: () => get<GitStatus>(url.git(r, "status")), staleTime: 1000 });
  } catch {
    return null;
  }
};

const showGit = () => useUi.setState({ activity: "git", leftOpen: true });

export const gitCommands: Command[] = [
  { id: "git.commit", group: "Git", title: "Commit…", icon: <GitCommitHorizontal />, keywords: "message", when: () => !!root(), run: () => { showGit(); setTimeout(() => useGitUi.getState().bumpFocusCommit(), 60); } },
  {
    id: "git.stage-all",
    group: "Git",
    title: "Stage all changes",
    icon: <Plus />,
    when: () => !!root(),
    run: async () => {
      const r = root();
      const s = r && (await status(r));
      if (!r || !s) return;
      const paths = s.files.filter((f) => f.worktree !== "." && !f.conflict).map((f) => f.path);
      if (paths.length === 0) return void toast("Nothing to stage");
      await gitActions(r).stage(paths);
    },
  },
  {
    id: "git.unstage-all",
    group: "Git",
    title: "Unstage all changes",
    icon: <RotateCcw />,
    when: () => !!root(),
    run: async () => {
      const r = root();
      const s = r && (await status(r));
      if (!r || !s) return;
      const paths = s.files.filter((f) => f.index !== "." && f.index !== "U").map((f) => f.path);
      if (paths.length === 0) return void toast("Nothing is staged");
      await gitActions(r).unstage(paths);
    },
  },
  { id: "git.fetch", group: "Git", title: "Fetch", icon: <RefreshCw />, when: () => !!root(), run: () => void gitActions(root()!).fetch() },
  { id: "git.pull", group: "Git", title: "Pull", icon: <ArrowDown />, when: () => !!root(), run: () => void gitActions(root()!).pull() },
  {
    id: "git.push",
    group: "Git",
    title: "Push",
    icon: <ArrowUp />,
    when: () => !!root(),
    run: async () => {
      const r = root()!;
      const s = await status(r);
      await gitActions(r).push(s && !s.upstream && s.branch ? { setUpstream: true, branch: s.branch } : {});
    },
  },
  { id: "git.branch", group: "Git", title: "Create branch…", icon: <GitBranch />, when: () => !!root(), run: () => void promptNewBranch(root()!) },
  { id: "git.checkout", group: "Git", title: "Checkout branch…", icon: <GitBranch />, keywords: "switch", when: () => !!root(), run: () => { showGit(); setTimeout(() => useGitUi.getState().setBranchPicker(true), 80); } },
  { id: "git.stash", group: "Git", title: "Stash changes…", icon: <Archive />, when: () => !!root(), run: () => void promptStash(root()!) },
  {
    id: "git.last-commit",
    group: "Git",
    title: "Open last commit",
    icon: <GitCommitHorizontal />,
    when: () => !!root(),
    run: async () => {
      const c = await gitActions(root()!).lastCommit();
      if (c) useUi.getState().openTab({ kind: "commit", root: root()!, sha: c.sha, title: c.short });
      else toast("No commits yet");
    },
  },
  {
    id: "git.discard-all",
    group: "Git",
    title: "Discard all changes…",
    icon: <RotateCcw />,
    when: () => !!root(),
    run: async () => {
      const r = root()!;
      const s = await status(r);
      if (!s || s.files.length === 0) return void toast("No changes to discard");
      const untracked = s.files.filter((f) => f.worktree === "?").length;
      const ok = await confirm({ title: `Discard all ${s.files.length} change${s.files.length === 1 ? "" : "s"}?`, description: `Resets tracked files to HEAD${untracked ? ` and deletes ${untracked} untracked file${untracked === 1 ? "" : "s"}` : ""}. This cannot be undone.`, confirmLabel: "Discard all", danger: true });
      if (ok) await gitActions(r).discard(s.files.filter((f) => !f.conflict).map((f) => f.path), true);
    },
  },
];

useCommandStore.getState().set("git", gitCommands);
