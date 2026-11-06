import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { get, post } from "@/lib/api";
import { navigate } from "@/lib/nav";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { CreatePanel } from "./CreatePanel";
import { projectTarget, repoFolderName, saveLastParent } from "./logic";

interface Job {
  id: string;
  status: "running" | "done" | "failed";
  step: string;
  log: string[];
  error: string | null;
  workspaceId: string | null;
}

export type ProjectKind = "empty" | "clone";

const COPY: Record<ProjectKind, { title: string; description: string; action: string }> = {
  empty: { title: "New empty folder", description: "Makes a folder for a new project, optionally sets up git, and opens it.", action: "Create folder" },
  clone: { title: "Clone from Git", description: "Clones a repository with its full history into a new folder and opens it. Private repositories work when git or SSH is already signed in.", action: "Clone" },
};

/** Home screen: start a project from nothing or from a git repository, inside the folder the browser beside it is showing. */
export function NewProjectPanel({ kind, parent, onClose }: { kind: ProjectKind; parent: string; onClose: () => void }) {
  const copy = COPY[kind];
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [shallow, setShallow] = useState(false);
  const [gitInit, setGitInit] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);

  useEffect(() => {
    // Each kind starts fresh (the panel stays mounted when the user switches between them).
    setJobId(null);
    setNameEdited(false);
    setName(kind === "empty" ? "my-project" : "");
    setUrl("");
    setRef("");
  }, [kind]);
  useEffect(() => {
    // The clone's folder follows the repository's name until the user types their own.
    if (kind === "clone" && !nameEdited) setName(repoFolderName(url));
  }, [kind, url, nameEdited]);

  const target = projectTarget(parent, name);
  const job = useQuery({
    queryKey: ["scaffold", "job", jobId],
    queryFn: () => get<{ job: Job }>(`/api/scaffold/jobs/${jobId}`).then((r) => r.job),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.status === "running" || !q.state.data ? 800 : false),
  });
  useEffect(() => {
    if (job.data?.status === "done" && job.data.workspaceId) {
      saveLastParent(parent);
      toast.success(kind === "clone" ? "Repository cloned" : "Folder created");
      onClose();
      navigate(`/w/${job.data.workspaceId}`);
    }
  }, [job.data?.status, job.data?.workspaceId, onClose, parent, kind]);

  const run = useMutation({
    mutationFn: () => post<{ job: Job }>("/api/scaffold/project", { kind, target, ...(kind === "clone" ? { url, ref, shallow } : { gitInit }) }),
    onSuccess: (r) => setJobId(r.job.id),
    onError: (e: Error) => toast.error(e.message),
  });

  const running = run.isPending || job.data?.status === "running" || (!!jobId && !job.data);
  const failed = job.data?.status === "failed";
  const ready = !!parent.trim() && !!name.trim() && (kind !== "clone" || !!url.trim());
  return (
    <CreatePanel
      title={copy.title}
      description={copy.description}
      location={parent}
      onClose={onClose}
      busy={running}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={running || !ready}
            onClick={() => {
              setJobId(null);
              run.mutate();
            }}
          >
            {running ? <Spinner /> : <Check />} {failed ? "Try again" : copy.action}
          </Button>
        </>
      }
    >
      {kind === "clone" && (
        <>
          <Field label="Repository" hint="owner/repo, an https:// URL, or git@host:owner/repo.git">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-xs" disabled={running} spellCheck={false} autoFocus placeholder="https://github.com/owner/repo" />
          </Field>
          <Field label="Branch or tag (optional)">
            <Input value={ref} onChange={(e) => setRef(e.target.value)} className="font-mono text-xs" disabled={running} spellCheck={false} placeholder="default branch" />
          </Field>
        </>
      )}
      <Field label={kind === "clone" ? "Folder name" : "Project folder"} hint={<span className="font-mono">{target}</span>}>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
          className="font-mono text-xs"
          disabled={running}
          spellCheck={false}
          autoFocus={kind === "empty"}
        />
      </Field>
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        {kind === "empty" ? <Checkbox checked={gitInit} onChange={setGitInit} label="Set up git" /> : <Checkbox checked={shallow} onChange={setShallow} label="Shallow clone" />}
        <span>{kind === "empty" ? "Set up git (git init and a first commit)" : "Shallow clone (latest commit only, faster for large repositories)"}</span>
      </div>
      {(jobId || run.isPending) && (
        <div className="rounded-lg border border-line bg-panel p-2">
          <div className={cn("mb-1 text-[11px] font-medium", failed ? "text-red" : "text-fg-muted")}>{failed ? job.data?.error : job.data?.step ?? "Starting"}</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug text-fg-faint">{job.data?.log.slice(-40).join("\n")}</pre>
        </div>
      )}
    </CreatePanel>
  );
}
