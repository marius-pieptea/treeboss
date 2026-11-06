import { useState } from "react";
import { ExternalLink, FileText, Hammer, Layers, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Badge, Spinner, StatusDot } from "@/components/ui/misc";
import { openSession } from "@/features/agent/agent-commands";
import { useUi } from "@/lib/store";
import { PaneSplitter, usePaneWidth } from "@/components/ui/splitter";
import { cn } from "@/lib/utils";
import { useChoices, type Actions, type ItemInput, type RoadmapItem, type RoadmapLane } from "./data";
import { SpecBar } from "./ItemCard";
import { parseTags, parseTarget, STATUS_LABEL } from "./logic";

/** The edit panel beside the board. Fields are uncontrolled and keyed by their saved value: typing is local, leaving a field writes it. */
export function ItemDrawer({ root, item, lanes, roadmapPath, actions, onClose, line }: { root: string; item: RoadmapItem; lanes: RoadmapLane[]; roadmapPath: string; actions: Actions; onClose: () => void; line?: number }) {
  const drawerW = usePaneWidth("roadmap.drawer", 372);
  const choices = useChoices(root, true);
  const openTab = useUi((s) => s.openTab);
  const [starting, setStarting] = useState<"spec" | "build" | null>(null);
  const k = item.key;
  const save = (patch: ItemInput) => actions.update.mutate({ key: item.key, patch });
  const span = parseTarget(item.target);

  const start = async (kind: "spec" | "build") => {
    setStarting(kind);
    try {
      const r = await actions.start.mutateAsync({ key: item.key, kind });
      openSession(r.session.id);
      toast.success(kind === "spec" ? "Spec session started" : "Build session started", { description: item.title });
    } catch {
      /* the mutation already said why */
    } finally {
      setStarting(null);
    }
  };

  const openFile = (path: string, ln?: number) => openTab({ kind: "file", root, path, title: path.split("/").pop() ?? path, line: ln });
  // A linked spec opens as the feature in the Specs view (stepper, tasks), a docs page in the Docs viewer.
  const openSpec = (dir: string, tab: "spec" | "tasks") => openTab({ kind: "spec", root, feature: dir.replace(/^specs\//, ""), title: dir.replace(/^specs\//, ""), doc: tab });
  const openDoc = (path: string) => openTab({ kind: "doc", root, path, title: path.split("/").pop() ?? path });

  const specOptions = [{ value: "", label: "No spec" }, ...(choices.data?.specs ?? []).map((s) => ({ value: s.path, label: s.path.replace(/^specs\//, ""), hint: s.title !== s.path.replace(/^specs\//, "") ? s.title : undefined })), ...(item.spec && !(choices.data?.specs ?? []).some((s) => s.path === item.spec) ? [{ value: item.spec, label: `${item.spec} (missing)` }] : [])];

  return (
    <aside data-roadmap-drawer style={{ width: drawerW }} className="absolute inset-y-0 right-0 z-20 flex max-w-full animate-slide-right flex-col border-l border-line-strong bg-panel shadow-pop">
      <PaneSplitter paneKey="roadmap.drawer" fallback={372} min={300} max={800} invert className="absolute inset-y-0 -left-px" />
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-[11px] text-fg-faint">{item.id ?? "no id yet"}</span>
        <Badge tone={item.status === "shipped" ? "green" : item.status === "in_progress" ? "accent" : "neutral"}>{STATUS_LABEL[item.status]}</Badge>
        <span className="flex-1" />
        <IconButton label="Open ROADMAP.md at this item" size="icon-sm" onClick={() => openFile(roadmapPath, line ?? item.line)}>
          <FileText />
        </IconButton>
        <IconButton label="Close" size="icon-sm" onClick={onClose} data-drawer-close>
          <X />
        </IconButton>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <Field label="Title">
          <Input
            key={`t:${k}:${item.title}`}
            defaultValue={item.title}
            data-field="title"
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== item.title && save({ title: e.target.value.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </Field>

        <div className="flex items-center gap-4">
          <Field label="Lane" className="flex-1">
            <Select value={item.lane} onChange={(lane) => lane !== item.lane && actions.move.mutate({ key: item.key, lane })} options={lanes.map((l) => ({ value: l.name, label: l.name }))} size="sm" aria-label="Lane" />
          </Field>
          <label className="flex items-center gap-2 pt-4 text-[12px] text-fg-muted">
            <Switch checked={item.done} onChange={(done) => save({ done })} label="Shipped" />
            Shipped
          </label>
        </div>

        <Field label="Description">
          <Textarea key={`d:${k}:${item.description}`} defaultValue={item.description} rows={4} data-field="description" placeholder="What and why. Indented under the item in ROADMAP.md." onBlur={(e) => e.target.value.trim() !== item.description.trim() && save({ description: e.target.value })} />
        </Field>

        <div className="flex gap-3">
          <Field label="Tags" className="flex-1" hint="comma separated">
            <Input key={`g:${k}:${item.tags.join(",")}`} defaultValue={item.tags.join(", ")} data-field="tags" placeholder="infra, ux" onBlur={(e) => JSON.stringify(parseTags(e.target.value)) !== JSON.stringify(item.tags) && save({ tags: parseTags(e.target.value) })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          </Field>
          <Field label="Target" className="w-[132px]">
            <Input key={`x:${k}:${item.target ?? ""}`} defaultValue={item.target ?? ""} data-field="target" placeholder="2026-Q4" onBlur={(e) => (e.target.value.trim() || null) !== item.target && save({ target: e.target.value.trim() || null })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          </Field>
        </div>
        {item.target && <p className={cn("-mt-2 text-[11px]", span ? "text-fg-faint" : "text-amber")}>{span ? `Reads as ${span.label}` : "Not a date, month or quarter: it will show as unscheduled."}</p>}

        <Field label="Spec" hint={item.links.spec && !item.links.spec.ok ? <span className="text-amber">{item.links.spec.reason}</span> : undefined}>
          <Select value={item.spec ?? ""} onChange={(v) => save({ spec: v || null })} options={specOptions} size="sm" placeholder="No spec" aria-label="Spec" />
        </Field>
        {item.progress && (
          <div className="-mt-1 flex items-center gap-2">
            <SpecBar item={item} className="flex-1" />
            {item.links.spec?.ok && (
              <Button size="xs" variant="ghost" data-open-spec onClick={() => openSpec(item.progress!.dir, item.progress!.hasTasks ? "tasks" : "spec")}>
                <Layers /> Open in Specs
              </Button>
            )}
          </div>
        )}

        <Field label="Docs" hint={item.links.docs && !item.links.docs.ok ? <span className="text-amber">{item.links.docs.reason}</span> : undefined}>
          <>
            <Input key={`o:${k}:${item.docs ?? ""}`} defaultValue={item.docs ?? ""} data-field="docs" list={`docs-${k}`} placeholder="docs/architecture.md" onBlur={(e) => (e.target.value.trim() || null) !== item.docs && save({ docs: e.target.value.trim() || null })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
            <datalist id={`docs-${k}`}>
              {(choices.data?.docs ?? []).map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </>
        </Field>
        {item.docs && item.links.docs?.ok && (
          <Button size="xs" variant="ghost" className="-mt-1" data-open-docs onClick={() => openDoc(item.links.docs!.path!)}>
            <ExternalLink /> Open in Docs
          </Button>
        )}

        <div className="space-y-1.5 pt-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">Work</div>
          <div className="flex flex-wrap gap-2">
            <Button variant={item.spec && item.links.spec?.ok ? "subtle" : "primary"} size="sm" data-start="spec" disabled={starting !== null} onClick={() => void start("spec")}>
              {starting === "spec" ? <Spinner /> : <Sparkles />} {item.spec && item.links.spec?.ok ? "Revise spec" : "Create spec from this item"}
            </Button>
            <Button variant={item.spec && item.links.spec?.ok ? "primary" : "subtle"} size="sm" data-start="build" disabled={starting !== null} onClick={() => void start("build")}>
              {starting === "build" ? <Spinner /> : <Hammer />} Start building
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-fg-faint">Creating a spec runs the Specify step: the spec folder is created and linked to this item, and the session writes spec.md. Continue in the Specs view (clarify, plan, tasks). Building attaches this item and its spec by reference.</p>
        </div>

        {item.sessions.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">Sessions</div>
            {item.sessions.map((s) => (
              <button key={s.id} type="button" data-drawer-session={s.id} onClick={() => openSession(s.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/40">
                <StatusDot status={s.status} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <Badge>{s.kind}</Badge>
              </button>
            ))}
          </div>
        )}
      </div>

      <footer className="flex items-center border-t border-line px-3 py-2">
        <Button
          variant="dangerGhost"
          size="sm"
          onClick={async () => {
            if (await confirm({ title: `Delete "${item.title}"?`, description: "Removes the item and its description from ROADMAP.md. Git has the old version.", confirmLabel: "Delete", danger: true })) {
              actions.remove.mutate(item.key);
              onClose();
            }
          }}
        >
          <Trash2 /> Delete
        </Button>
        <span className="flex-1" />
        <span className="text-[11px] text-fg-faint">line {item.line}</span>
      </footer>
    </aside>
  );
}
