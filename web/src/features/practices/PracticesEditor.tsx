import { useState } from "react";
import { ArrowDown, ArrowUp, GitFork, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { useSkills } from "@/features/settings/data";
import { cn } from "@/lib/utils";
import { CheckRow } from "./CheckRow";
import { usePackActions, usePracticeCatalog, type Pack } from "./data";
import { blankDraft, draftOf, draftProblem, inputOf, sameDraft, unknownSkills, type PackDraft } from "./logic";

/**
 * Every pack the daemon knows, with an editor for the one picked. Built-in packs are edited in place (they show as
 * modified), can be forked into a custom copy, and reset to what shipped. Custom packs are created, edited and deleted.
 * The checks of a built-in pack can be switched off here, for everyone; a workspace switches rules and checks off in
 * its own Practices panel.
 */
export function PracticesEditor({ onBack }: { onBack?: () => void }) {
  const catalog = usePracticeCatalog();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const packs = catalog.data?.packs ?? [];
  const current = creating ? null : (packs.find((p) => p.id === selected) ?? packs[0] ?? null);

  return (
    <section className="flex flex-col gap-3" aria-label="Edit practice packs">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[length:var(--text-sm)] text-fg-muted">Rules, checks and skills the agents follow. Built-in packs can be edited and reset; custom packs are yours.</p>
        <div className="flex shrink-0 items-center gap-2">
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack}>
              Back
            </Button>
          )}
          <Button variant="subtle" size="sm" onClick={() => setCreating(true)} disabled={creating}>
            <Plus /> New pack
          </Button>
        </div>
      </div>

      {catalog.isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="flex min-h-0 flex-col gap-3 md:flex-row">
          <ul className="flex shrink-0 flex-col gap-1 md:w-60" aria-label="Packs">
            {packs.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setSelected(p.id);
                  }}
                  aria-current={!creating && current?.id === p.id ? "true" : undefined}
                  className={cn("flex w-full flex-col items-start gap-1 rounded-md border px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent", !creating && current?.id === p.id ? "border-line-strong bg-active" : "border-line hover:bg-hover")}
                >
                  <span className="text-[length:var(--text-base)] font-medium">{p.title}</span>
                  <span className="flex flex-wrap items-center gap-1">
                    <PackBadge pack={p} />
                    <Badge>{p.rules.length} rules</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0 flex-1">
            {creating ? (
              <PackEditor key="new" isNew pack={null} taken={packs.map((p) => p.id)} stacks={catalog.data?.stacks ?? []} onSelect={(id) => { setCreating(false); setSelected(id); }} onCancel={() => setCreating(false)} />
            ) : current ? (
              <PackEditor key={current.id} isNew={false} pack={current} taken={[]} stacks={catalog.data?.stacks ?? []} onSelect={setSelected} onCancel={() => undefined} />
            ) : (
              <Empty title="No packs" hint="Create a custom pack to start." />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The origin of a pack: built-in (as shipped), modified (a built-in with an edit), or custom. */
export function PackBadge({ pack }: { pack: Pack }) {
  if (pack.custom) return <Badge>custom</Badge>;
  return pack.modified ? <Badge tone="amber">modified</Badge> : <Badge>built-in</Badge>;
}

function PackEditor({ pack, isNew, taken, stacks, onSelect, onCancel }: { pack: Pack | null; isNew: boolean; taken: string[]; stacks: string[]; onSelect: (id: string | null) => void; onCancel: () => void }) {
  const original = pack ? draftOf(pack) : blankDraft(taken);
  const [draft, setDraft] = useState<PackDraft>(original);
  const [confirming, setConfirming] = useState(false);
  const actions = usePackActions();
  const skills = useSkills();
  const installed = skills.data?.map((s) => s.name);
  const builtin = !!pack && !pack.custom;
  const dirty = !sameDraft(draft, original);
  const problem = draftProblem(draft, { isNew, builtin });
  const busy = actions.create.isPending || actions.edit.isPending || actions.fork.isPending || actions.reset.isPending || actions.remove.isPending;
  const missing = unknownSkills(draft.skills, installed);

  const set = <K extends keyof PackDraft>(k: K, v: PackDraft[K]) => setDraft({ ...draft, [k]: v });
  const setRule = (i: number, text: string) => set("rules", draft.rules.map((r, j) => (j === i ? text : r)));
  const moveRule = (i: number, to: number) => {
    if (to < 0 || to >= draft.rules.length) return;
    const next = [...draft.rules];
    [next[i], next[to]] = [next[to]!, next[i]!];
    set("rules", next);
  };

  const save = () => {
    const input = inputOf(draft, { isNew, builtin });
    if (isNew) actions.create.mutate(input, { onSuccess: (r) => onSelect(r.pack.id) });
    else if (pack) actions.edit.mutate({ id: pack.id, ...input });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-panel p-3" aria-label={isNew ? "New pack" : `Edit ${pack?.title ?? "pack"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-lg)] font-semibold">{isNew ? "New custom pack" : pack?.title}</h2>
        {pack && <PackBadge pack={pack} />}
        {pack && <span className="font-mono text-[length:var(--text-xs)] text-fg-muted">{pack.id}</span>}
      </div>

      {pack && (
        <div className="flex flex-wrap items-center gap-2">
          {builtin && (
            <Button variant="subtle" size="sm" disabled={busy} onClick={() => actions.fork.mutate({ id: pack.id }, { onSuccess: (r) => onSelect(r.pack.id) })}>
              <GitFork /> Fork into a custom pack
            </Button>
          )}
          {builtin && pack.modified && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => actions.reset.mutate({ id: pack.id })}>
              <RotateCcw /> Reset to default
            </Button>
          )}
          {pack.custom && !confirming && (
            <Button variant="dangerGhost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              <Trash2 /> Delete
            </Button>
          )}
          {pack.custom && confirming && (
            <>
              <span className="text-[length:var(--text-sm)] text-fg-muted">Delete this pack? It is switched off in every workspace.</span>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => actions.remove.mutate({ id: pack.id }, { onSuccess: () => onSelect(null) })}>
                Delete pack
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          )}
        </div>
      )}

      {isNew && (
        <Field label="Id" hint="Lowercase letters, digits and dashes. It cannot change later.">
          <Input value={draft.id} onChange={(e) => set("id", e.target.value.toLowerCase())} className="font-mono" aria-label="Pack id" maxLength={40} />
        </Field>
      )}
      <Field label="Title">
        <Input value={draft.title} onChange={(e) => set("title", e.target.value)} maxLength={60} aria-label="Pack title" />
      </Field>
      <Field label="Summary">
        <Input value={draft.summary} onChange={(e) => set("summary", e.target.value)} maxLength={200} aria-label="Pack summary" />
      </Field>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Applies to</legend>
        <div className="flex flex-wrap gap-3">
          {stacks.map((s) => (
            <CheckRow key={s} label={s} checked={draft.appliesTo.includes(s)} onChange={(on) => set("appliesTo", on ? [...draft.appliesTo, s] : draft.appliesTo.filter((x) => x !== s))} />
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Rules</legend>
        {draft.rules.map((rule, i) => (
          <div key={i} className="flex items-center gap-1">
            <span className="w-5 shrink-0 text-right font-mono text-[length:var(--text-xs)] text-fg-muted">{i + 1}</span>
            <Input value={rule} onChange={(e) => setRule(i, e.target.value)} maxLength={200} aria-label={`Rule ${i + 1}`} className="flex-1" />
            <IconButton label="Move rule up" onClick={() => moveRule(i, i - 1)} disabled={i === 0}>
              <ArrowUp />
            </IconButton>
            <IconButton label="Move rule down" onClick={() => moveRule(i, i + 1)} disabled={i === draft.rules.length - 1}>
              <ArrowDown />
            </IconButton>
            <IconButton label="Remove rule" onClick={() => set("rules", draft.rules.filter((_, j) => j !== i))} disabled={draft.rules.length === 1}>
              <X />
            </IconButton>
          </div>
        ))}
        <div>
          <Button variant="ghost" size="sm" disabled={draft.rules.length >= 8} onClick={() => set("rules", [...draft.rules, ""])}>
            <Plus /> Add rule
          </Button>
        </div>
      </fieldset>

      {builtin && pack && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Checks</legend>
          <p className="text-[length:var(--text-sm)] text-fg-muted">The mechanical checks this pack runs. A check left off here stops for every workspace that has the pack on.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {pack.knownChecks.map((c) => (
              <CheckRow key={c} mono label={c} checked={draft.checks.includes(c)} onChange={(on) => set("checks", on ? [...draft.checks, c] : draft.checks.filter((x) => x !== c))} />
            ))}
          </div>
        </fieldset>
      )}

      <SkillsField skills={draft.skills} installed={installed} missing={missing} onChange={(next) => set("skills", next)} />

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        {problem && dirty && <span className="mr-auto text-[length:var(--text-sm)] text-red">{problem}</span>}
        {isNew ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(original)}>
            Revert
          </Button>
        )}
        <Button variant="primary" size="sm" disabled={!dirty || !!problem || busy} onClick={save}>
          {isNew ? "Create pack" : "Save pack"}
        </Button>
      </div>
    </div>
  );
}

/** Skills by name. Installed skills are suggested; one that is not installed is flagged, and the pack still saves. */
function SkillsField({ skills, installed, missing, onChange }: { skills: string[]; installed: string[] | undefined; missing: string[]; onChange: (next: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const name = text.trim();
    if (!name || skills.includes(name)) return setText("");
    onChange([...skills, name]);
    setText("");
  };
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Skills</legend>
      <p className="text-[length:var(--text-sm)] text-fg-muted">Skills the agent should load for this pack. The block says &quot;Use the NAME skill if available.&quot;</p>
      {skills.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Skills of this pack">
          {skills.map((s) => (
            <li key={s} className="flex items-center gap-1">
              <Badge tone={missing.includes(s) ? "amber" : "neutral"} title={missing.includes(s) ? "Not among the installed skills" : undefined}>
                {s}
                {missing.includes(s) && " · not installed"}
              </Badge>
              <IconButton label={`Remove skill ${s}`} onClick={() => onChange(skills.filter((x) => x !== s))}>
                <X />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          list="practice-skill-names"
          placeholder="skill-name"
          aria-label="Add a skill"
          className="max-w-xs font-mono"
        />
        <datalist id="practice-skill-names">
          {(installed ?? []).map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <Button variant="subtle" size="sm" onClick={add} disabled={!text.trim()}>
          Add skill
        </Button>
      </div>
    </fieldset>
  );
}
