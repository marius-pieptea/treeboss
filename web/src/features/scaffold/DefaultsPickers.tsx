import { useQuery } from "@tanstack/react-query";
import { Badge, Skeleton } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/form";
import { get } from "@/lib/api";
import { usePracticeCatalog } from "@/features/practices/data";

/** The checklist catalog as the picker needs it: an id and a title. The route may carry more; the picker reads only these. */
interface ChecklistEntry {
  id: string;
  title?: string;
}

/**
 * The defaults a workspace made from this template gets: practice packs switched on, and checklists attached. Both are
 * picked from the catalogs as they are now. A selection the catalog no longer has (a deleted custom pack) still shows,
 * marked missing, so it can be unticked; the daemon refuses to save a template that names an unknown pack.
 */
export function TemplateDefaults({ practices, checklists, onPractices, onChecklists }: { practices: string[]; checklists: string[]; onPractices: (ids: string[]) => void; onChecklists: (ids: string[]) => void }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line p-3" aria-label="Defaults for a workspace made from this template">
      <div className="text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Defaults for the workspace</div>
      <PracticePicker value={practices} onChange={onPractices} />
      <ChecklistPicker value={checklists} onChange={onChecklists} />
    </section>
  );
}

function toggle(list: string[], id: string, on: boolean): string[] {
  return on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
}

export function PracticePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const catalog = usePracticeCatalog();
  if (catalog.isLoading) return <Skeleton className="h-16" />;
  const packs = catalog.data?.packs ?? [];
  const known = new Set(packs.map((p) => p.id));
  const missing = value.filter((id) => !known.has(id));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Practice packs</legend>
      <p className="text-[length:var(--text-sm)] text-fg-muted">Switched on for the workspace. Its rules go into AGENTS.md when it is made.</p>
      <ul className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2" aria-label="Practice packs to switch on">
        {packs.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <Checkbox label={p.title} checked={value.includes(p.id)} onChange={(on) => onChange(toggle(value, p.id, on))} />
            <span className="font-mono text-[length:var(--text-xs)] text-fg-muted">{p.id}</span>
            {p.custom && <Badge>custom</Badge>}
          </li>
        ))}
        {missing.map((id) => (
          <li key={id} className="flex items-center gap-2">
            <Checkbox label={id} checked onChange={(on) => onChange(toggle(value, id, on))} />
            <Badge tone="amber">missing</Badge>
          </li>
        ))}
      </ul>
      {!packs.length && <span className="text-[length:var(--text-sm)] text-fg-muted">No practice packs yet.</span>}
    </fieldset>
  );
}

export function ChecklistPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const list = useQuery({
    queryKey: ["checklists-catalog"],
    queryFn: () => get<{ checklists?: ChecklistEntry[] }>("/api/checklists").then((r) => r.checklists ?? []),
    staleTime: 60_000,
  });
  if (list.isLoading) return <Skeleton className="h-16" />;
  const entries = list.data ?? [];
  const known = new Map(entries.map((c) => [c.id, c.title ?? c.id]));
  const missing = value.filter((id) => !known.has(id));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[length:var(--text-xs)] font-medium uppercase tracking-[var(--tracking-label)] text-fg-muted">Checklists</legend>
      <p className="text-[length:var(--text-sm)] text-fg-muted">Attached to the workspace when it is made. Leave all off to use the catalog's defaults for this template.</p>
      <ul className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2" aria-label="Checklists to attach">
        {entries.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <Checkbox label={c.title ?? c.id} checked={value.includes(c.id)} onChange={(on) => onChange(toggle(value, c.id, on))} />
            <span className="font-mono text-[length:var(--text-xs)] text-fg-muted">{c.id}</span>
          </li>
        ))}
        {missing.map((id) => (
          <li key={id} className="flex items-center gap-2">
            <Checkbox label={id} checked onChange={(on) => onChange(toggle(value, id, on))} />
            <Badge tone="amber">missing</Badge>
          </li>
        ))}
      </ul>
      {!entries.length && !missing.length && <span className="text-[length:var(--text-sm)] text-fg-muted">No checklists in the catalog.</span>}
    </fieldset>
  );
}
