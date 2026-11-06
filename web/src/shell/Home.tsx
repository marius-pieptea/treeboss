import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, ChevronsUpDown, Folder, FolderPlus, GitFork, HardDrive, FolderGit2, FolderOpen, Home as HomeIcon, Sparkles, X } from "lucide-react";
import { del, get, post, qs } from "@/lib/api";
import { navigate } from "@/lib/nav";
import { qk, queryClient, useWorkspaces } from "@/lib/queries";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { DropdownMenu } from "@/components/ui/overlay";
import { Empty, Spinner } from "@/components/ui/misc";
import { Logo } from "./Logo";
import { ago, cn } from "@/lib/utils";
import { toast } from "sonner";
import { NewAppPanel } from "@/features/scaffold/NewAppPanel";
import { NewProjectPanel, type ProjectKind } from "@/features/scaffold/NewProjectPanel";
import { readLastParent } from "@/features/scaffold/logic";

interface Browse {
  path: string;
  parent: string | null;
  home: string;
  repo: boolean;
  /** Windows only: the drive roots that exist ("C:\\", "D:\\"). Empty elsewhere. */
  drives?: string[];
  entries: Array<{ name: string; path: string; repo: boolean }>;
}

/** The folder browser. It is also where a new project's location comes from: `onCurrent` reports the folder being shown. */
function FolderPicker({ dir, setDir, onOpen, onCurrent }: { dir: string; setDir: (d: string) => void; onOpen: (dir: string) => void; onCurrent: (dir: string) => void }) {
  const [typed, setTyped] = useState("");
  const q = useQuery({ queryKey: ["browse", dir], queryFn: () => get<Browse>(`/api/browse${qs({ path: dir })}`), retry: false });
  const cur = q.data?.path ?? dir;
  useEffect(() => {
    if (q.data?.path) onCurrent(q.data.path);
  }, [q.data?.path, onCurrent]);
  const go = (p: string) => {
    setDir(p);
    setTyped("");
  };
  return (
    <div className="flex h-[360px] flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-1.5 border-b border-line p-2">
        <Button variant="ghost" size="icon-sm" disabled={!q.data?.parent} onClick={() => q.data?.parent && go(q.data.parent)} title="Up">
          <ArrowUp />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => go(q.data?.home ?? "")} title="Home">
          <HomeIcon />
        </Button>
        {q.data?.drives && q.data.drives.length > 1 && (
          <DropdownMenu
            entries={q.data.drives.map((d) => ({ label: d, icon: <HardDrive />, checked: cur.toUpperCase().startsWith(d.toUpperCase()), onSelect: () => go(d) }))}
            trigger={
              <Button variant="ghost" size="sm" className="gap-1 px-2 font-mono text-xs" title="Switch drive">
                <HardDrive />
                {cur.slice(0, 2).toUpperCase()}
                <ChevronsUpDown className="size-3 text-fg-faint" />
              </Button>
            }
          />
        )}
        <Input
          className="h-7 font-mono text-xs"
          value={typed || cur}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typed) go(typed);
          }}
          spellCheck={false}
          aria-label="Folder path"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {q.isLoading && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
        {q.error && <div className="p-3 text-xs text-red">{(q.error as Error).message}</div>}
        {q.data?.entries.map((e) => (
          <button key={e.path} onDoubleClick={() => onOpen(e.path)} onClick={() => go(e.path)} className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover">
            {e.repo ? <FolderGit2 className="size-4 text-accent" /> : <Folder className="size-4 text-fg-faint" />}
            <span className="flex-1 truncate">{e.name}</span>
            <ChevronRight className="size-3.5 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
        {q.data && q.data.entries.length === 0 && <div className="p-4 text-center text-xs text-fg-faint">No subfolders</div>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line p-2">
        <span className={cn("truncate pl-1 font-mono text-[11px]", q.data?.repo ? "text-accent" : "text-fg-faint")}>{q.data?.repo ? "git repository" : "plain folder"}</span>
        <Button variant="primary" onClick={() => cur && onOpen(cur)} disabled={!cur}>
          <FolderOpen /> Open this folder
        </Button>
      </div>
    </div>
  );
}

export function Home() {
  const ws = useWorkspaces();
  const [project, setProject] = useState<ProjectKind | "app" | null>(null);
  const [dir, setDir] = useState<string>(() => readLastParent());
  const [here, setHere] = useState("");
  const closePanel = useCallback(() => setProject(null), []);
  const open = useMutation({
    mutationFn: (path: string) => post<{ workspace: { id: string } }>("/api/workspaces", { path }),
    onSuccess: (r) => navigate(`/w/${r.workspace.id}`),
    onError: (e: Error) => toast.error(e.message),
  });
  // Forgets the folder in trb's list only; the folder and its sessions on disk are left alone.
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/workspaces/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.workspaces }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="relative flex h-full overflow-auto bg-bg">
      {/* Nothing to click up here: in the desktop app this is where the window is dragged from. */}
      <div className="app-dragstrip fixed inset-x-0 top-0 z-10 h-9" aria-hidden />
      <div className="m-auto grid w-full max-w-[920px] gap-10 p-8 md:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 animate-slide-up">
          <div className="mb-6 flex items-center gap-3">
            <Logo size={34} />
            <div>
              <h1 className="text-[20px] font-semibold tracking-tight">trb</h1>
              <p className="text-xs text-fg-muted">Coding agents, Hydra pairs, one workspace.</p>
            </div>
          </div>
          {project === "app" ? (
            <NewAppPanel parent={here} onClose={closePanel} />
          ) : project ? (
            <NewProjectPanel kind={project} parent={here} onClose={closePanel} />
          ) : (
            <>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Recent</h2>
          {ws.isLoading ? (
            <Spinner />
          ) : !ws.data?.length ? (
            <Empty icon={<FolderOpen />} title="No workspaces yet" hint="Pick a folder on the right to start." className="rounded-xl border border-dashed border-line" />
          ) : (
            <div className="flex max-h-[min(26rem,60dvh)] flex-col gap-1 overflow-y-auto overscroll-contain pr-1">
              {ws.data.map((w, i) => (
                <div key={w.id} style={{ animationDelay: `${i * 30}ms` }} className="group relative animate-slide-up flex items-center rounded-lg border border-transparent transition-colors hover:border-line hover:bg-panel focus-within:border-accent/50">
                  <button onClick={() => navigate(`/w/${w.id}`)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left outline-none">
                    <FolderGit2 className="size-4 shrink-0 text-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{w.name}</div>
                      <div className="truncate font-mono text-[11px] text-fg-faint">{w.path}</div>
                    </div>
                    <span className="text-[11px] text-fg-faint">{ago(w.last_opened)}</span>
                    <ChevronRight className="size-4 text-fg-faint transition-transform group-hover:translate-x-0.5" />
                  </button>
                  <IconButton label={`Remove ${w.name} from the list`} variant="dangerGhost" size="icon-sm" className="mr-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" disabled={remove.isPending} onClick={() => remove.mutate(w.id)}>
                    <X />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
            </>
          )}
        </div>
        <div className="animate-slide-up" style={{ animationDelay: "60ms" }}>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Choose a folder</h2>
          <FolderPicker dir={dir} setDir={setDir} onOpen={(p) => open.mutate(p)} onCurrent={setHere} />
          <p className="mb-1.5 mt-3 text-[11px] text-fg-faint">Or start something new inside the folder shown above:</p>
          <div className="grid grid-cols-2 gap-2">
            <Button data-new-project="empty" aria-pressed={project === "empty"} onClick={() => setProject("empty")}>
              <FolderPlus /> New empty folder
            </Button>
            <Button data-new-project="clone" aria-pressed={project === "clone"} onClick={() => setProject("clone")}>
              <GitFork /> Clone from Git
            </Button>
          </div>
          <Button data-new-project="app" aria-pressed={project === "app"} className="mt-2 w-full" onClick={() => setProject("app")}>
            <Sparkles /> New app from a recipe
          </Button>
        </div>
      </div>
    </div>
  );
}
