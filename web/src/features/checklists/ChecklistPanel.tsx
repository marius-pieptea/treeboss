import { useEffect, useMemo, useRef, useState } from "react";
import { ListChecks, Pencil, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { openSession } from "@/features/agent/agent-commands";
import { openFindings } from "@/features/lab/open";
import { openSettingsPage } from "@/features/settings/commands";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Checkbox, Input, Select } from "@/components/ui/form";
import { Badge, Empty, SegTabs, Skeleton } from "@/components/ui/misc";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { type ChecklistItemState, type ItemSource, type ItemStatus, useAttachedChecklists, useChecklistActions, useChecklistCatalog, useCheckUrls, useStack } from "./data";
import { isDisabledItem } from "./editor-logic";
import { ProjectItemForm } from "./ProjectItemForm";

const STATUS_WORD: Record<ItemStatus, string> = { pass: "passing", fail: "failing", unknown: "not verified", na: "not applicable" };
const STATUS_DOT: Record<ItemStatus, string> = { pass: "bg-green", fail: "bg-red", unknown: "bg-fg-faint", na: "bg-fg-faint" };
const SOURCE_TITLE: Record<ItemSource, string> = { auto: "Answered by a check", agent: "Answered by an audit agent", manual: "Ticked by a person" };
const LOCAL_ONLY = "";

/** A checklist to show, and an item of it to bring into view (the Lab sets this when it links to one). */
export interface ChecklistFocus {
  checklist: string;
  item: string | null;
}

/** The launch checklists of the workspace: the detected stack, progress, items by category, the checks, and the audit agent. */
export function ChecklistPanel({ focus }: { focus?: ChecklistFocus | null }) {
  const { workspace } = useWorkspace();
  const ws = workspace.id;
  const attached = useAttachedChecklists(ws);
  const catalog = useChecklistCatalog();
  const urls = useCheckUrls(ws);
  const stack = useStack(ws);
  const actions = useChecklistActions(ws);
  const [active, setActive] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState(LOCAL_ONLY);
  const [auditSession, setAuditSession] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = attached.data ?? [];
  const current = list.find((c) => c.id === active) ?? list[0] ?? null;
  const unattached = (catalog.data ?? []).filter((c) => !list.some((a) => a.id === c.id));
  // Item ids are only unique within a checklist, so the focused item counts only on the checklist it names.
  const focusItem = focus && current?.id === focus.checklist ? focus.item : null;

  useEffect(() => {
    if (focus) setActive(focus.checklist);
  }, [focus]);

  const groups = useMemo(() => {
    const out = new Map<string, ChecklistItemState[]>();
    for (const i of current?.items ?? []) out.set(i.category, [...(out.get(i.category) ?? []), i]);
    return [...out.entries()];
  }, [current]);

  const attachOne = (id: string) => {
    actions.attach.mutate(id, {
      onSuccess: () => {
        setActive(id);
        setPicking(false);
      },
    });
  };

  const startAudit = (fix: boolean) => {
    if (!current) return;
    actions.audit.mutate({ checklistId: current.id, fix }, { onSuccess: (r) => setAuditSession(r.sessionId) });
  };

  const detachCurrent = async () => {
    if (!current) return;
    const ok = await confirm({ title: `Detach ${current.title}?`, description: "Its item state is forgotten. The checks and the deploy gate stop using it.", confirmLabel: "Detach", danger: true });
    if (ok) actions.detach.mutate(current.id, { onSuccess: () => setActive(null) });
  };

  if (attached.isLoading) return <Skeleton className="m-3 h-24" />;

  if (!current) {
    return (
      <section className="flex flex-col gap-3 p-3" aria-label="Launch checklists">
        <Empty
          icon={<ListChecks />}
          title="No checklist attached"
          hint="A checklist tracks launch readiness. Required items that do not pass block prod deploys."
          action={
            <div className="flex flex-col gap-1">
              {(catalog.data ?? []).map((c) => (
                <Button key={c.id} variant="subtle" size="sm" onClick={() => attachOne(c.id)} disabled={actions.attach.isPending}>
                  <Plus /> {c.title}
                </Button>
              ))}
            </div>
          }
        />
      </section>
    );
  }

  const p = current.progress;
  const settled = p.requiredPassing + p.requiredNotApplicable;
  const pct = p.requiredTotal ? Math.round((settled / p.requiredTotal) * 100) : 0;

  return (
    <section className="flex flex-col gap-3 p-3" aria-label="Launch checklists">
      <div className="flex flex-wrap items-center gap-2">
        <SegTabs
          value={current.id}
          onChange={setActive}
          items={list.map((c) => ({ value: c.id, label: c.title, badge: `${c.progress.requiredPassing}/${c.progress.requiredTotal}` }))}
        />
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => openSettingsPage("checklists")}>
            <Pencil /> Manage checklists
          </Button>
          {picking ? (
            <>
              {unattached.map((c) => (
                <Button key={c.id} variant="ghost" size="sm" onClick={() => attachOne(c.id)} disabled={actions.attach.isPending}>
                  {c.title}
                </Button>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="subtle" size="sm" onClick={() => setPicking(true)} disabled={!unattached.length}>
              <Plus /> Attach checklist
            </Button>
          )}
        </div>
      </div>

      {stack.data && (
        <div className="flex min-w-0 flex-wrap items-baseline gap-2 text-xs text-fg-muted" aria-label="Detected stack">
          <span className="font-medium uppercase tracking-label">Stack</span>
          <span className="font-mono text-fg">{stack.data.stack}</span>
          {stack.data.templateExts.length > 0 && <span className="font-mono">{stack.data.templateExts.join(" ")}</span>}
          {stack.data.evidence[0] && (
            <span className="min-w-0 truncate" title={stack.data.evidence.join("\n")}>
              {stack.data.evidence[0]}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 text-xs text-fg-muted">
          <span>
            <span className="font-mono text-fg">{p.requiredPassing}</span> of <span className="font-mono">{p.requiredTotal}</span> required passing
            {p.requiredNotApplicable > 0 && (
              <>
                , <span className="font-mono">{p.requiredNotApplicable}</span> not applicable
              </>
            )}
          </span>
          <span className="font-mono">
            {p.passing}/{p.total} all items
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-raised" role="progressbar" aria-label="Required items settled" aria-valuemin={0} aria-valuemax={p.requiredTotal} aria-valuenow={settled}>
          <div className="h-full rounded-full bg-green transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          {p.unverified > 0 ? (
            <>
              <span className="size-2 shrink-0 rounded-full bg-amber" aria-hidden />
              <span>
                <span className="font-mono text-fg">{p.unverified}</span> not verified. Run an audit with the agent to check them in the code.
              </span>
            </>
          ) : (
            <span>Every item has an answer.</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          value={target}
          onChange={setTarget}
          aria-label="What to check"
          options={[{ value: LOCAL_ONLY, label: "Static checks only" }, ...(urls.data ?? []).map((u) => ({ value: u.url, label: `${u.label} · ${u.url}` }))]}
        />
        <Button variant="primary" size="sm" onClick={() => actions.run.mutate(target || null)} disabled={actions.run.isPending}>
          <Play /> {actions.run.isPending ? "Checking" : "Run checks"}
        </Button>
        <Button variant="subtle" size="sm" onClick={() => startAudit(false)} disabled={actions.audit.isPending}>
          <ListChecks /> Audit with agent
        </Button>
        <Button variant="subtle" size="sm" onClick={() => startAudit(true)} disabled={actions.audit.isPending}>
          <Sparkles className="text-accent" /> Fix with agent
        </Button>
        {auditSession && (
          <Button variant="ghost" size="sm" onClick={() => openSession(auditSession)}>
            Open audit session <span className="font-mono">{auditSession}</span>
          </Button>
        )}
        <Button variant="subtle" size="sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
          <Plus /> Add item to this project
        </Button>
        <div className="ml-auto">
          <Button variant="dangerGhost" size="sm" onClick={detachCurrent}>
            <Trash2 /> Detach
          </Button>
        </div>
      </div>

      {adding && (
        <ProjectItemForm
          pending={actions.addItem.isPending}
          onCancel={() => setAdding(false)}
          onSubmit={(item) => actions.addItem.mutate({ checklistId: current.id, item }, { onSuccess: () => setAdding(false) })}
        />
      )}

      <div className="flex flex-col gap-4">
        {groups.map(([category, items]) => (
          <div key={category} className="flex flex-col gap-1">
            <h3 className="text-xs font-medium uppercase tracking-label text-fg-muted">{category}</h3>
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel" aria-label={`${category} items`}>
              {items.map((i) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  focused={i.id === focusItem}
                  onTick={(checked) => actions.setItem.mutate({ checklistId: current.id, itemId: i.id, checked })}
                  onNote={(note) => actions.setItem.mutate({ checklistId: current.id, itemId: i.id, note })}
                  onDisable={(disabled) => actions.setItem.mutate({ checklistId: current.id, itemId: i.id, disabled })}
                  onRemove={() => actions.removeItem.mutate({ checklistId: current.id, itemId: i.id })}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function ItemRow({ item, focused, onTick, onNote, onDisable, onRemove }: { item: ChecklistItemState; focused: boolean; onTick: (checked: boolean) => void; onNote: (note: string | null) => void; onDisable: (disabled: boolean) => void; onRemove: () => void }) {
  const [noting, setNoting] = useState(false);
  const [draft, setDraft] = useState(item.note ?? "");
  const ref = useRef<HTMLLIElement>(null);
  const isLink = !!item.evidence && /^https?:\/\//.test(item.evidence);
  const open = item.status !== "pass" && item.status !== "na";
  const disabled = isDisabledItem(item);

  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);

  return (
    <li ref={ref} data-checklist-item={item.id} className={cn("flex flex-col gap-1 px-3 py-2", focused && "bg-accent-soft/40")}>
      <div className="flex items-start gap-3">
        <Checkbox checked={item.status === "pass"} onChange={onTick} label={`${item.text}: ${STATUS_WORD[item.status]}`} className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[item.status])} aria-hidden />
            <span className="text-xs text-fg-muted">{STATUS_WORD[item.status]}</span>
            <span className={cn("min-w-0", item.status === "pass" && "text-fg-muted line-through decoration-fg-faint")}>{item.text}</span>
            {item.severity === "required" && <Badge tone="neutral">required</Badge>}
            <Badge tone="neutral">{item.kind}</Badge>
            {item.source && (
              <Badge tone="neutral" title={SOURCE_TITLE[item.source]}>
                {item.source}
              </Badge>
            )}
            {item.custom && <Badge tone="neutral">custom</Badge>}
          </div>
          {item.message && <p className="mt-1 text-xs text-fg-muted">{item.message}</p>}
          {item.reason && <p className="mt-1 text-xs text-fg-muted">{item.status === "na" ? `Not applicable: ${item.reason}` : `Agent: ${item.reason}`}</p>}
          {item.evidence && (
            <p className="mt-1 truncate font-mono text-xs text-fg-muted">
              {isLink ? (
                <a href={item.evidence} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:text-fg">
                  {item.evidence}
                </a>
              ) : (
                item.evidence
              )}
            </p>
          )}
          {disabled && <p className="mt-1 text-xs text-fg-muted">Disabled for this project: it does not apply here, and the checks and audits leave it alone.</p>}
          {item.note && !noting && !disabled && <p className="mt-1 text-xs text-fg-muted">Note: {item.note}</p>}
          {open && <p className="mt-1 text-xs text-fg-muted">{item.hint}</p>}
        </div>
        {item.finding && (
          <Button variant="ghost" size="sm" aria-label={`Lab finding for ${item.text}`} onClick={() => openFindings({ finding: item.finding ?? undefined })}>
            Finding
          </Button>
        )}
        <Button variant="ghost" size="sm" aria-label={`Note on ${item.text}`} onClick={() => setNoting((v) => !v)}>
          Note
        </Button>
        <Button variant="ghost" size="sm" aria-label={`${disabled ? "Enable" : "Disable"} ${item.text} for this project`} onClick={() => onDisable(!disabled)}>
          {disabled ? "Enable here" : "Disable for this project"}
        </Button>
        {item.custom && (
          <Button variant="dangerGhost" size="sm" aria-label={`Remove ${item.text} from this project`} onClick={onRemove}>
            <Trash2 />
          </Button>
        )}
      </div>
      {noting && (
        <form
          className="flex items-center gap-2 pl-7"
          onSubmit={(e) => {
            e.preventDefault();
            onNote(draft.trim() || null);
            setNoting(false);
          }}
        >
          <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Why it is done or left open" className="h-7" aria-label="Note" />
          <Button type="submit" variant="subtle" size="sm">
            Save
          </Button>
        </form>
      )}
    </li>
  );
}
