import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, FileDown, FolderPlus, Plus, RefreshCw, RotateCcw, Save, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/overlay";
import { Input } from "@/components/ui/form";
import { Badge, Empty, SegTabs, Skeleton, Spinner } from "@/components/ui/misc";
import { confirm } from "@/components/ui/dialogs";
import { useHotkey } from "@/lib/hooks";
import { ApiError, get, post } from "@/lib/api";
import { useAgents } from "@/lib/queries";
import type { Skill } from "@/lib/types";
import { api, keys, useAction, useSkillFile, useSkillPacks, useSkills } from "./data";
import { PaneSplitter, usePaneWidth } from "@/components/ui/splitter";
import { MarkdownEditor } from "./MarkdownEditor";
import { NewSkillDialog } from "./SkillDialogs";
import { FileCountBadges, SkillFiles } from "./skills-files";
import { ImportDialog, ImportIndicator, startReimport } from "./skills-import";
import { PackGroup, SkillRow } from "./skills-list";
import { packSections, unpackedSkills } from "./skills-logic";
import { skillKeys, skillRoot, skillsApi } from "./skills-api";
import { useSkillImport } from "./skills-state";
import { useUi } from "@/lib/store";
import { ErrorNote } from "./shared";
import { DIALOG_PAGE, useSettingsUi } from "./ui-state";

/** The frontmatter block is metadata, not prose: show it as a header in the preview, not as a rule and a paragraph. */
function splitFrontmatter(md: string): { meta: Array<[string, string]>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: [], body: md };
  const meta: Array<[string, string]> = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) meta.push([kv[1], kv[2].replace(/^["']|["']$/g, "")]);
  }
  return { meta, body: m[2] };
}

function Preview({ text }: { text: string }) {
  const { meta, body } = useMemo(() => splitFrontmatter(text), [text]);
  return (
    <div className="h-full overflow-auto px-6 py-5">
      {meta.length > 0 && (
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-line bg-raised/50 px-3 py-2 text-xs">
          {meta.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-fg-faint">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="markdown max-w-[80ch] [&_ol]:list-decimal [&_ul]:list-disc">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </div>
    </div>
  );
}

function SkillEditor({ skill, onDeleted }: { skill: Skill; onDeleted: () => void }) {
  const filesW = usePaneWidth("skills.files", 200);
  const name = skill.name;
  const qc = useQueryClient();
  const file = useSkillFile(name);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const loaded = useRef<string | null>(null);

  // A fresh load (opening a skill, or reloading after a conflict) replaces the draft; background refetches must not.
  useEffect(() => {
    if (file.data && loaded.current !== `${name}:${file.data.mtime}`) {
      loaded.current = `${name}:${file.data.mtime}`;
      setDraft(file.data.content);
      setVersion((v) => v + 1);
    }
  }, [file.data, name]);

  const dirty = !!file.data && draft !== file.data.content;

  // SKILL.md may have been edited in an editor tab or by an agent: pick that up when the window is looked at again,
  // unless there are unsaved edits here to protect.
  useEffect(() => {
    const on = () => {
      if (!dirty) void file.refetch();
    };
    window.addEventListener("focus", on);
    return () => window.removeEventListener("focus", on);
  }, [dirty, file]);

  const openTab = useUi((u) => u.openTab);
  const qc2 = useQueryClient();
  const source = useQuery({
    queryKey: skillKeys.source(name, skill.source),
    enabled: !!skill.source && !skill.builtin,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const scan = await skillsApi.scan(skill.source!);
      return scan.skills.some((x) => x.name === name);
    },
  });
  const reimport = async () => {
    try {
      await startReimport(name, skill.source!);
    } catch (e: any) {
      toast.error(e.message);
    }
    qc2.invalidateQueries({ queryKey: skillKeys.source(name, skill.source) });
  };

  const save = async (overwriteStale = false) => {
    if (!file.data || saving) return;
    setSaving(true);
    try {
      const r = await api.skills.save(name, draft, file.data.mtime);
      loaded.current = `${name}:${r.mtime}`;
      qc.setQueryData(keys.skillFile(name), { ...file.data, content: draft, mtime: r.mtime });
      qc.invalidateQueries({ queryKey: keys.skills });
      toast.success("Skill saved");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !overwriteStale) {
        const mtime = e.body?.mtime as number;
        const overwrite = await confirm({ title: "SKILL.md changed on disk", description: "Something edited this file since you opened it (an agent, another editor). Overwrite it with your version, or reload theirs and lose your edits?", confirmLabel: "Overwrite", danger: true });
        if (overwrite && file.data) {
          qc.setQueryData(keys.skillFile(name), { ...file.data, mtime });
          setSaving(false);
          return save(true);
        }
        if (!overwrite) await file.refetch();
      } else toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  useHotkey({ key: "s", mod: true }, () => void save(), { allowInInput: true, enabled: dirty });

  const remove = useAction(() => api.skills.remove(name), { invalidate: [keys.skills, MISSING_KEY], success: `Deleted ${name}` });
  const reset = async () => {
    if (!(await confirm({ title: `Reset ${name} to the version that ships with trb?`, description: dirty ? "Your unsaved edits and your saved changes to this skill are replaced." : "Your changes to this skill are replaced.", confirmLabel: "Reset", danger: true }))) return;
    try {
      await post(`/api/skills/${encodeURIComponent(name)}/reset`);
      await qc.invalidateQueries({ queryKey: keys.skills });
      await file.refetch();
      toast.success(`${name} reset to the default`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const del = async () => {
    if (await confirm({ title: `Delete ${name}?`, description: skill.builtin ? "It ships with trb: Restore built-in skills brings it back." : "The skill's files are removed from trb's store. Folders you imported it from are not touched.", confirmLabel: "Delete", danger: true })) {
      await remove.mutateAsync();
      onDeleted();
    }
  };

  if (file.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (file.error) return <div className="p-6"><ErrorNote>{(file.error as Error).message}</ErrorNote></div>;

  return (
    <div className="@container flex h-full min-w-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="min-w-0 truncate font-mono text-[13px] font-semibold" title={name}>{name}</span>
        <FileCountBadges name={name} />
        {dirty && <Badge tone="amber" className="shrink-0">unsaved</Badge>}
        {skill.builtin && (
          <Badge tone="accent" className="shrink-0" title="Ships with trb. Edit it freely; Reset puts the shipped text back.">
            {skill.modified ? "built-in, edited" : "built-in"}
          </Badge>
        )}
        <div className="flex-1" />
        {skill.builtin && (
          <Button variant="ghost" size="sm" aria-label="Reset to default" onClick={() => void reset()} disabled={!skill.modified && !dirty} title={skill.modified || dirty ? "Put the version that ships with trb back" : "Already the shipped version"} className="shrink-0">
            <RotateCcw /> <span className="@max-[720px]:hidden">Reset</span>
          </Button>
        )}
        {skill.source && !skill.builtin && (
          <Button variant="ghost" size="sm" aria-label="Re-import from source" onClick={() => void reimport()} disabled={!source.data} title={source.data ? `Copy the skill again from ${skill.source}` : source.isLoading ? "Checking the source folder…" : `${skill.source} no longer has this skill`} className="shrink-0">
            <RefreshCw /> <span className="@max-[720px]:hidden">Re-import</span>
          </Button>
        )}
        <Button variant="outline" size="sm" aria-label="Open SKILL.md" onClick={() => void openTab({ kind: "file", root: skillRoot(name), path: "SKILL.md", title: `SKILL.md · ${name}` })} className="shrink-0">
          <BookOpen /> <span className="@max-[720px]:hidden">Open SKILL.md</span>
        </Button>
        <Button variant={dirty ? "primary" : "subtle"} size="sm" onClick={() => void save()} disabled={!dirty || saving} aria-label="Save skill" className="shrink-0">
          {saving ? <Spinner className="text-current" /> : dirty ? <Save /> : <Check />}
          <span className="@max-[720px]:hidden">{dirty ? "Save" : "Saved"}</span>
        </Button>
        <IconButton label="Delete skill" variant="dangerGhost" size="icon-sm" onClick={del}>
          <Trash2 />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1">
        <div style={{ width: filesW }} className="flex shrink-0 flex-col">
          <SkillFiles name={name} storedPath={skill.path} className="min-h-0 flex-1" />
        </div>
        <PaneSplitter paneKey="skills.files" fallback={200} min={140} max={480} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-4">
            <SegTabs className="w-40 shrink-0" value={mode} onChange={setMode} items={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} />
            <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint @max-[720px]:hidden">SKILL.md: the entry point. Other files open in an editor tab.</span>
          </div>
          <div className="min-h-0 flex-1">{mode === "edit" ? <MarkdownEditor key={`${name}:${version}`} value={draft} onChange={setDraft} onSave={() => void save()} label={`${name} SKILL.md`} /> : <Preview text={draft} />}</div>
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center justify-between border-t border-line px-4 font-mono text-[10.5px] text-fg-faint">
        <span className="min-w-0 truncate" title={skill.path}>{skill.path}</span>
        <span className="ml-3 shrink-0 whitespace-nowrap">{draft.split("\n").length} lines</span>
      </div>
    </div>
  );
}

const MISSING_KEY = ["skills", "missing-builtins"] as const;

export function SkillsPage() {
  const listW = usePaneWidth("skills.list", 260);
  const q = useSkills();
  const qc = useQueryClient();
  const missing = useQuery({ queryKey: MISSING_KEY, queryFn: () => get<{ missingBuiltins?: string[] }>("/api/skills").then((r) => r.missingBuiltins ?? []), staleTime: 2000 });
  const restore = async () => {
    try {
      const r = await post<{ added: string[] }>("/api/skills/restore-builtins");
      await qc.invalidateQueries({ queryKey: keys.skills });
      await qc.invalidateQueries({ queryKey: MISSING_KEY });
      toast.success(r.added.length ? `Restored ${r.added.join(", ")}` : "Nothing to restore");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const selected = useSettingsUi((s) => s.selectedSkill);
  const select = useSettingsUi((s) => s.selectSkill);
  const dialog = useSettingsUi((s) => s.dialog);
  const closeDialog = useSettingsUi((s) => s.close);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<"new" | null>(null);
  const openImport = useSkillImport((i) => i.openDialog);
  const agents = useAgents();

  useEffect(() => {
    if (!dialog || DIALOG_PAGE[dialog] !== "skills") return;
    if (dialog === "skill-new") setOpen("new");
    else openImport(dialog === "skill-add" ? "single" : "directory");
    closeDialog();
  }, [dialog, closeDialog, openImport]);

  // Descriptions live in each SKILL.md and can change under us (an editor tab, an agent): keep the list current.
  useEffect(() => {
    const t = setInterval(() => void q.refetch(), 4000);
    return () => clearInterval(t);
  }, [q]);

  const skills = q.data ?? [];
  const packs = useSkillPacks();
  const own = unpackedSkills(skills, filter);
  const sections = packSections(packs.data ?? [], skills, filter);
  const matches = own.length + sections.reduce((n, p) => n + p.skills.length, 0);
  // Packs are collapsed until opened. A search opens the packs it finds something in; selecting one of their skills opens its pack.
  const [openPacks, setOpenPacks] = useState<Record<string, boolean>>({});
  const selectedPack = skills.find((s) => s.name === selected)?.pack ?? null;
  useEffect(() => {
    if (selectedPack) setOpenPacks((prev) => (prev[selectedPack] ? prev : { ...prev, [selectedPack]: true }));
  }, [selectedPack]);
  const onFilter = (value: string) => {
    setFilter(value);
    if (!value.trim()) return;
    const found = packSections(packs.data ?? [], skills, value).map((p) => [p.id, true] as const);
    if (found.length) setOpenPacks((prev) => ({ ...prev, ...Object.fromEntries(found) }));
  };
  useEffect(() => {
    // The default selection is the operator's first skill of its own, so the page opens on what it did before packs.
    if (skills.length && (!selected || !skills.some((s) => s.name === selected))) select((skills.find((s) => !s.pack) ?? skills[0]).name);
    if (!skills.length && selected) select(null);
  }, [skills, selected, select]);

  const toggle = useAction((a: { name: string; on: boolean }) => api.skills.toggle(a.name, a.on), { invalidate: [keys.skills] });
  const togglePack = useAction((a: { id: string; on: boolean }) => api.skills.togglePack(a.id, a.on), {
    invalidate: [keys.skills],
    success: (r, a) => `${a.id}: ${r.enabled} of ${r.installed} skills ${a.on ? "on" : "off"}`,
  });
  const done = (name: string) => {
    setOpen(null);
    q.refetch();
    select(name);
    toast.success(`Added ${name}`);
  };

  return (
    <div className="flex h-full bg-panel">
      <aside style={{ width: listW }} className="flex shrink-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <h1 className="flex-1 text-[14px] font-semibold">Skills</h1>
          <DropdownMenu
            align="end"
            trigger={
              <Button variant="primary" size="sm">
                <Plus /> Add
              </Button>
            }
            entries={[
              { label: "New skill…", icon: <Plus />, onSelect: () => setOpen("new") },
              { label: "From a folder…", icon: <FolderPlus />, onSelect: () => openImport("single") },
              { label: "Import a folder of skills…", icon: <FileDown />, onSelect: () => openImport("directory") },
            ]}
          />
        </div>
        <div className="border-b border-line p-2 empty:hidden">
          <ImportIndicator />
        </div>
        <div className="relative border-b border-line p-2">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
          <Input value={filter} onChange={(e) => onFilter(e.target.value)} placeholder="Filter skills" className="h-7 pl-7 text-xs" aria-label="Filter skills" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {q.isLoading && <Skeleton className="m-1 h-12" />}
          {!q.isLoading && skills.length === 0 && <Empty icon={<BookOpen />} title="No skills yet" hint="Skills are reusable instructions an agent loads when they fit the work." />}
          {own.map((s, i) => (
            <SkillRow key={s.name} s={s} index={i} selected={selected === s.name} agents={agents.data ?? []} onSelect={select} onToggle={(on) => toggle.mutate({ name: s.name, on })} />
          ))}
          {sections.map((p) => (
            <PackGroup
              key={p.id}
              section={p}
              open={!!openPacks[p.id]}
              busy={togglePack.isPending && togglePack.variables?.id === p.id}
              selected={selected}
              agents={agents.data ?? []}
              onOpenChange={(o) => setOpenPacks((prev) => ({ ...prev, [p.id]: o }))}
              onSelect={select}
              onToggle={(name, on) => toggle.mutate({ name, on })}
              onToggleAll={(on) => togglePack.mutate({ id: p.id, on })}
            />
          ))}
          {skills.length > 0 && matches === 0 && <div className="p-4 text-center text-xs text-fg-faint">No skill matches “{filter}”.</div>}
        </div>
        {!!missing.data?.length && (
          <div className="border-t border-line p-2">
            <Button variant="ghost" size="sm" className="w-full" onClick={() => void restore()} title={`Adds back: ${missing.data.join(", ")}`} data-skills-restore>
              <RotateCcw /> Restore built-in skills ({missing.data.length})
            </Button>
          </div>
        )}
        <div className="border-t border-line px-3 py-2 text-[11px] text-fg-faint">{skills.filter((s) => s.enabled).length} of {skills.length} enabled. Enabled skills are placed where each engine looks for them, for the length of a turn.</div>
      </aside>
      <PaneSplitter paneKey="skills.list" fallback={260} min={200} max={520} />
      <main className="min-w-0 flex-1">{selected && skills.find((x) => x.name === selected) ? <SkillEditor key={selected} skill={skills.find((x) => x.name === selected)!} onDeleted={() => select(null)} /> : <Empty icon={<BookOpen />} title="Select a skill" hint="Pick one on the left to read or edit it and its files." className="h-full" />}</main>

      <NewSkillDialog open={open === "new"} onClose={() => setOpen(null)} onDone={done} />
      <ImportDialog onFinished={() => void q.refetch()} />
    </div>
  );
}
