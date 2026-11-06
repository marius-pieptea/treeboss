import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ban, Check, Pencil } from "lucide-react";
import { get, post } from "@/lib/api";
import { navigate } from "@/lib/nav";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form";
import { Badge, Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { openSettingsPage } from "../settings/commands";
import { CreatePanel } from "./CreatePanel";
import { RecipeIcon } from "./icons";
import { projectTarget, saveLastParent } from "./logic";
import { useTemplates } from "./TemplatesPage";
import { useSystems } from "../design/data";
import { defaultSystemFor } from "../design/logic";
import { ColorStrip } from "../design/Swatches";

const LAST_DESIGN = "trb.newapp.design";
const readLast = (): string | null => {
  try {
    return localStorage.getItem(LAST_DESIGN);
  } catch {
    return null;
  }
};

interface Job {
  id: string;
  status: "running" | "done" | "failed";
  step: string;
  log: string[];
  error: string | null;
  workspaceId: string | null;
  sessionId: string | null;
}

/** Home screen: scaffold a new app from a template inside the folder the browser beside it is showing, then open it with a starter session. Templates are edited in Settings. */
export function NewAppPanel({ parent, onClose }: { parent: string; onClose: () => void }) {
  const recipes = useTemplates();
  const systems = useSystems();
  const [recipe, setRecipe] = useState("");
  /** The design system to write into the project; "" is none. */
  const [design, setDesign] = useState("");
  const [name, setName] = useState("my-app");
  const [describe, setDescribe] = useState("");
  const [session, setSession] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);

  const list = recipes.data?.recipes ?? [];
  useEffect(() => {
    // Keep the choice valid when the list changes (a template was deleted in Settings).
    if (list.length && !list.some((r) => r.id === recipe)) setRecipe(list[0]!.id);
  }, [recipe, list]);

  const designs = systems.data?.systems ?? [];
  const tag = list.find((r) => r.id === recipe)?.tag ?? "";
  useEffect(() => {
    // Follow the template: none for an API or CLI, else the system used last time.
    if (recipe && systems.data) setDesign(defaultSystemFor(tag, readLast(), systems.data.systems.map((s) => s.id)));
  }, [recipe, tag, systems.data]);
  const pickDesign = (id: string) => {
    setDesign(id);
    try {
      localStorage.setItem(LAST_DESIGN, id);
    } catch {}
  };

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
      toast.success("App created");
      onClose();
      navigate(`/w/${job.data.workspaceId}`);
    }
  }, [job.data?.status, job.data?.workspaceId, onClose, parent]);

  const run = useMutation({
    mutationFn: () => post<{ job: Job }>("/api/scaffold/run", { recipe, target, describe, session, ...(design ? { designSystem: design } : {}) }),
    onSuccess: (r) => setJobId(r.job.id),
    onError: (e: Error) => toast.error(e.message),
  });

  const running = run.isPending || job.data?.status === "running" || (!!jobId && !job.data);
  const failed = job.data?.status === "failed";
  return (
    <CreatePanel
      title="New app from a recipe"
      description="Runs the template's generator in a new folder, sets up git and dependencies, writes AGENTS.md, and opens a session."
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
            disabled={running || !recipe || !name.trim() || !parent.trim()}
            onClick={() => {
              setJobId(null);
              run.mutate();
            }}
          >
            {running ? <Spinner /> : <Check />} {failed ? "Try again" : "Create app"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-1.5">
          {list.map((r) => (
            <button key={r.id} data-recipe={r.id} onClick={() => setRecipe(r.id)} disabled={running} aria-pressed={recipe === r.id} className={cn("flex items-start gap-2 rounded-lg border p-2.5 text-left outline-none transition-colors", recipe === r.id ? "border-accent/60 bg-accent-soft" : "border-line hover:border-line-strong")}>
              <RecipeIcon name={r.icon} className="mt-0.5 size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">
                  {r.name}
                  {r.tag && <span className="ml-1.5 text-[10.5px] font-normal text-fg-faint">{r.tag}</span>}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-fg-muted">{r.description}</span>
                {!!(r.practices?.length || r.checklists?.length) && (
                  <span className="mt-1 flex flex-wrap gap-1" data-recipe-defaults>
                    {!!r.practices?.length && (
                      <Badge title={`Practice packs: ${r.practices.join(", ")}`}>{r.practices.length} practices</Badge>
                    )}
                    {r.checklists?.map((c) => (
                      <Badge key={c} title="Launch checklist">
                        {c}
                      </Badge>
                    ))}
                  </span>
                )}
                {!!r.repos?.length && (
                  <span className="mt-0.5 block truncate font-mono text-[10.5px] text-fg-faint" title={r.repos.map((x) => `${x.role}: ${x.url}`).join("\n")}>
                    {r.repos.map((x) => `${x.role === "starter" ? "from" : "reads"} ${x.url.replace("https://github.com/", "")}`).join(" · ")}
                  </span>
                )}
              </span>
            </button>
          ))}
          {recipes.isLoading && <div className="col-span-2 py-4 text-center text-xs text-fg-faint">Loading templates…</div>}
          {recipes.data && !list.length && <div className="col-span-2 rounded-lg border border-dashed border-line p-3 text-center text-xs text-fg-muted">No templates yet. Add or restore some in Settings.</div>}
        </div>
        <button
          data-edit-templates
          disabled={running}
          onClick={() => {
            onClose();
            openSettingsPage("templates");
          }}
          className="flex items-center gap-1.5 self-start rounded text-[11.5px] text-fg-muted outline-none hover:text-fg focus-visible:text-fg"
        >
          <Pencil className="size-3" /> Edit templates in Settings
        </button>
        <Field label="Design system" hint={design ? "Writes DESIGN.md and design/tokens.css, and tells agents to build the UI from them." : "No design files. You can add one later from the Design tab."}>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Design system">
            {[{ id: "", name: "None", description: "No design system", summary: null }, ...designs].map((s) => (
              <button key={s.id || "none"} type="button" role="radio" aria-checked={design === s.id} data-design-pick={s.id} onClick={() => pickDesign(s.id)} disabled={running} title={s.description} className={cn("flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40", design === s.id ? "border-accent/60 bg-accent-soft font-medium" : "border-line text-fg-muted hover:border-line-strong hover:text-fg")}>
                {s.summary ? <ColorStrip summary={s.summary} className="h-3 w-9 rounded-sm" /> : <Ban className="size-3 text-fg-faint" />}
                {s.name}
              </button>
            ))}
          </div>
        </Field>
        <Field label="App folder" hint={<span className="font-mono">{target}</span>}>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-xs" disabled={running} spellCheck={false} />
        </Field>
        <Field label="What should it be? (optional)">
          <Textarea value={describe} onChange={(e) => setDescribe(e.target.value)} className="h-16" disabled={running} placeholder="A habit tracker with streaks and a weekly summary" />
        </Field>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Checkbox checked={session} onChange={setSession} label="Open a session with the starter prompt" />
          <span>Open a session with the starter prompt</span>
        </div>
        {(jobId || run.isPending) && (
          <div className="rounded-lg border border-line bg-panel p-2">
            <div className={cn("mb-1 text-[11px] font-medium", failed ? "text-red" : "text-fg-muted")}>{failed ? job.data?.error : job.data?.step ?? "Starting"}</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-snug text-fg-faint">{job.data?.log.slice(-40).join("\n")}</pre>
          </div>
        )}
      </div>
    </CreatePanel>
  );
}
