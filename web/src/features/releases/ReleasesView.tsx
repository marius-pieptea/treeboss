import { useEffect, useState } from "react";
import { GitBranch, Package, Sparkles } from "lucide-react";
import { WhoPicker, useWho } from "@/components/agent-who";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Empty, SegTabs, Spinner } from "@/components/ui/misc";
import { Markdown } from "@/features/agent/Markdown";
import { useUi } from "@/lib/store";
import { AUDIENCES, BUMPS, useDraft, useEnvs, useProductNotes, useProductReleases, useProducts, useRange, useReleaseActions, useReleases, type Audience, type DraftBump, type RangeData, type ReleaseDoc } from "./data";

type BaseKind = "last" | "tag" | "sha" | "date";
const BASE_KINDS: Array<{ value: BaseKind; label: string }> = [
  { value: "last", label: "Last tag" },
  { value: "tag", label: "Tag" },
  { value: "sha", label: "Commit" },
  { value: "date", label: "Date" },
];

/** Release notes for one workspace (the drafts, the published releases) or for a product across its repos. */
export function ReleasesView({ root }: { root: string }) {
  const [mode, setMode] = useState<"workspace" | "product">("workspace");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <SegTabs value={mode} onChange={setMode} items={[{ value: "workspace", label: "Workspace" }, { value: "product", label: "Product" }]} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{mode === "workspace" ? <WorkspaceReleases root={root} /> : <ProductReleases />}</div>
    </div>
  );
}

function WorkspaceReleases({ root }: { root: string }) {
  const view = useReleases(root);
  const [kind, setKind] = useState<BaseKind>("last");
  const [tag, setTag] = useState("");
  const [typed, setTyped] = useState("");
  const [base, setBase] = useState("");
  const [prs, setPrs] = useState(false);
  const [bump, setBump] = useState<DraftBump>("auto");
  const [audience, setAudience] = useState<Audience>("users");
  const [selected, setSelected] = useState<string | null>(null);
  const [lastSession, setLastSession] = useState<string | null>(null);
  const [who, setWho] = useWho();

  // The base point: a tag from the list, or a commit or date typed in and committed on Enter or blur.
  const committed = kind === "tag" ? tag : kind === "last" ? "" : base;
  const range = useRange(root, committed, prs);
  const actions = useReleaseActions(root);
  // A commit or a date is not a base until it is typed and committed: until then there is nothing to preview.
  const ready = kind === "sha" || kind === "date" ? base !== "" : true;

  useEffect(() => {
    if (kind === "tag" && !tag && view.data?.tags[0]) setTag(view.data.tags[0]);
  }, [kind, tag, view.data]);

  const commitTyped = () => setBase(typed.trim());
  const drafts = view.data?.drafts ?? [];
  const current = drafts.find((d) => d.version === selected) ?? drafts[0] ?? null;
  const draft = useDraft(root, current?.version ?? null);
  const session = current?.sessionId ?? lastSession;

  const startDraft = () => {
    actions.draft.mutate(
      { base: committed, bump, audience, ...who },
      { onSuccess: (r) => setLastSession(r.sessionId) },
    );
  };

  return (
    <div className="flex flex-col gap-5 p-4">
      <section className="flex flex-col gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">Range</h3>
          <span className="font-mono text-xs text-fg-muted">{view.data?.head.branch ?? "detached"} · HEAD {view.data?.head.sha ?? "…"}</span>
          {view.data?.dirty && <Badge tone="amber">uncommitted changes</Badge>}
        </header>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Base point">
            <SegTabs value={kind} onChange={setKind} items={BASE_KINDS} />
          </Field>
          {kind === "tag" && (
            <Field label="Tag">
              <Select value={tag} onChange={setTag} options={(view.data?.tags ?? []).map((t) => ({ value: t, label: t }))} placeholder="No tags yet" aria-label="Base tag" />
            </Field>
          )}
          {(kind === "sha" || kind === "date") && (
            <Field label={kind === "sha" ? "Commit" : "Since (YYYY-MM-DD)"}>
              <Input
                className="font-mono"
                placeholder={kind === "sha" ? "3f9c1a2" : "2026-10-01"}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onBlur={commitTyped}
                onKeyDown={(e) => e.key === "Enter" && commitTyped()}
              />
            </Field>
          )}
          <label className="flex cursor-pointer items-center gap-1 pb-2 text-[12px] text-fg-muted select-none">
            <Checkbox checked={prs} onChange={setPrs} label="Include merged PRs (gh)" />
            Include merged PRs (gh)
          </label>
        </div>

        {range.isLoading && <Spinner />}
        {range.isError && <p className="text-sm text-red">{range.error instanceof Error ? range.error.message : "The range did not load."}</p>}
        {!ready && <p className="text-xs text-fg-muted">Type a {kind === "sha" ? "commit" : "date"} and press Enter.</p>}
        {ready && range.data && <RangePreview range={range.data} />}
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-fg">Draft with agent</h3>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Bump">
            <Select value={bump} onChange={(v) => setBump(v as DraftBump)} options={BUMPS.map((b) => ({ value: b, label: b === "auto" ? "auto (agent proposes)" : b }))} aria-label="Bump" />
          </Field>
          <Field label="Audience">
            <SegTabs value={audience} onChange={setAudience} items={AUDIENCES.map((a) => ({ value: a, label: a }))} />
          </Field>
          <WhoPicker who={who} onChange={setWho} inline />
          <Button variant="primary" disabled={!ready || !range.data || range.data.commits.length === 0 || actions.draft.isPending} onClick={startDraft}>
            {actions.draft.isPending ? <Spinner /> : <Sparkles />}
            Draft with agent
          </Button>
          {session && (
            <Button variant="ghost" onClick={() => useUi.getState().openTab({ kind: "session", sessionId: session, title: "Release notes" })}>
              Open session
            </Button>
          )}
        </div>
        {view.data?.version && (
          <p className="font-mono text-xs text-fg-muted">
            {view.data.version.file} {view.data.version.version} · patch {view.data.version.candidates.patch} · minor {view.data.version.candidates.minor} · major {view.data.version.candidates.major}
          </p>
        )}
      </section>

      <section className="grid gap-4 border-t border-line pt-4 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg">Drafts</h3>
          {drafts.length === 0 && <Empty title="No drafts" hint={`Drafts are written to ${view.data?.draftsDir ?? "releases/drafts"}.`} />}
          {drafts.map((d) => (
            <button
              key={d.version}
              type="button"
              onClick={() => setSelected(d.version)}
              className={`flex flex-col gap-1 rounded-md border px-3 py-2 text-left ${current?.version === d.version ? "border-line-strong bg-active" : "border-line hover:bg-hover"}`}
            >
              <span className="flex items-center gap-2 font-mono text-sm text-fg">
                {d.version}
                <Badge tone="amber">draft</Badge>
                {d.meta.bump && <span className="text-xs text-fg-muted">{d.meta.bump}</span>}
              </span>
              {d.meta.reason && <span className="truncate text-xs text-fg-muted">{d.meta.reason}</span>}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {current && draft.data ? (
            <DraftEditor
              key={current.version}
              doc={draft.data}
              onSave={(body) => actions.save.mutate({ version: current.version, body })}
              saving={actions.save.isPending}
              canRevise={!!session}
              onRevise={(instructions) => actions.revise.mutate({ version: current.version, instructions })}
              revising={actions.revise.isPending}
              publishing={actions.publish.isPending}
              onPublish={async (options) => {
                const ok = await confirm({
                  title: `Publish v${current.version}?`,
                  description: "Bumps the version files, prepends the notes to CHANGELOG.md, commits and tags. Nothing else is written.",
                  confirmLabel: "Publish",
                });
                if (ok) actions.publish.mutate({ version: current.version, options });
              }}
              root={root}
            />
          ) : (
            <Empty icon={<Package />} title="No draft selected" hint="Pick a draft, or draft the notes with the agent above." />
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-fg">Published</h3>
        {(view.data?.releases.length ?? 0) === 0 && <Empty title="No published releases" hint="A release lands here once a draft is published." />}
        <ol className="flex flex-col">
          {view.data?.releases.map((r) => <TimelineItem key={r.version} release={r} />)}
        </ol>
      </section>
    </div>
  );
}

function RangePreview({ range }: { range: RangeData }) {
  const n = range.commits.length;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3">
      <p className="text-sm text-fg">
        <span className="font-mono">{range.base.label}</span>
        {range.base.sha && <span className="font-mono text-fg-muted"> ({range.base.sha.slice(0, 7)})</span>} → HEAD
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-fg-muted">
        <span>{n} commit{n === 1 ? "" : "s"}</span>
        <span>{range.diff.files} files</span>
        <span className="text-green">+{range.diff.insertions}</span>
        <span className="text-red">−{range.diff.deletions}</span>
        <span>{range.roadmap.length} roadmap item{range.roadmap.length === 1 ? "" : "s"}</span>
        <span>{range.specs.length} spec{range.specs.length === 1 ? "" : "s"} with tasks done</span>
        {range.prs.length > 0 && <span>{range.prs.length} merged PRs</span>}
      </div>
      {range.breaking.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-red">
          {range.breaking.slice(0, 6).map((b) => (
            <li key={b}>breaking: {b}</li>
          ))}
        </ul>
      )}
      {range.warnings.map((w) => (
        <p key={w} className="text-xs text-amber">
          {w}
        </p>
      ))}
      {n > 0 && (
        <ul className="flex max-h-40 flex-col gap-0.5 overflow-auto text-xs text-fg-muted">
          {range.commits.slice(0, 40).map((c) => (
            <li key={c.sha} className="truncate">
              <span className="font-mono text-fg-faint">{c.sha.slice(0, 7)}</span> {c.subject}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DraftEditor({
  doc,
  root,
  onSave,
  saving,
  canRevise,
  onRevise,
  revising,
  publishing,
  onPublish,
}: {
  doc: ReleaseDoc;
  root: string;
  onSave: (body: string) => void;
  saving: boolean;
  canRevise: boolean;
  onRevise: (instructions: string) => void;
  revising: boolean;
  publishing: boolean;
  onPublish: (o: { push: boolean; ghRelease: boolean; deploy: string | null }) => void;
}) {
  const [text, setText] = useState(doc.body ?? "");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [ask, setAsk] = useState("");
  const [push, setPush] = useState(false);
  const [gh, setGh] = useState(false);
  const [deploy, setDeploy] = useState("");
  const envs = useEnvs(root);
  const dirty = text !== (doc.body ?? "");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-fg">{doc.version}</span>
        <Badge tone="amber">{doc.meta.status ?? "draft"}</Badge>
        {doc.meta.bump && <Badge>{doc.meta.bump}</Badge>}
        <span className="text-xs text-fg-muted">from {doc.meta.from ?? "?"}</span>
        <div className="ml-auto">
          <SegTabs value={view} onChange={setView} items={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} />
        </div>
      </div>
      {doc.meta.reason && <p className="text-xs text-fg-muted">{doc.meta.reason}</p>}

      {view === "edit" ? (
        <Textarea className="min-h-64 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} aria-label="Notes" />
      ) : (
        <div className="min-h-64 rounded-md border border-line bg-raised p-3">{text.trim() ? <Markdown text={text} /> : <p className="text-xs text-fg-muted">Nothing to preview.</p>}</div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="subtle" disabled={!dirty || saving} onClick={() => onSave(text)}>
          {saving && <Spinner />}
          Save draft
        </Button>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <label className="text-xs font-medium uppercase tracking-wide text-fg-muted" htmlFor="revise-ask">
          Ask agent to revise
        </label>
        <div className="flex gap-2">
          <Input id="revise-ask" placeholder="e.g. group the auth changes under Security, shorter bullets" value={ask} onChange={(e) => setAsk(e.target.value)} />
          <Button variant="outline" disabled={!canRevise || !ask.trim() || revising} onClick={() => {
              onRevise(ask);
              setAsk("");
            }}>
            {revising && <Spinner />}
            Ask agent
          </Button>
        </div>
        {!canRevise && <p className="text-xs text-fg-muted">The session that wrote this draft is not available to revise it.</p>}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
        <h4 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Publish</h4>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex cursor-pointer items-center gap-1 text-[12px] text-fg-muted select-none">
            <Checkbox checked={push || gh} onChange={setPush} label="Push" />
            Push
          </label>
          <label className="flex cursor-pointer items-center gap-1 text-[12px] text-fg-muted select-none">
            <Checkbox
              checked={gh}
              onChange={(on) => {
                setGh(on);
                if (on) setPush(true);
              }}
              label="GitHub release"
            />
            GitHub release
          </label>
          <Field label="Deploy after">
            <Select value={deploy} onChange={setDeploy} options={[{ value: "", label: "No deploy" }, ...(envs.data ?? []).map((e) => ({ value: e, label: e }))]} aria-label="Deploy environment" />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button variant="outline" disabled={publishing || dirty} onClick={() => onPublish({ push: push || gh, ghRelease: gh, deploy: deploy || null })} title={dirty ? "Save the draft first" : undefined}>
            {publishing && <Spinner />}
            <GitBranch />
            Publish {doc.version}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TimelineItem({ release }: { release: ReleaseDoc }) {
  return (
    <li className="flex gap-3 border-l border-line py-2 pl-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 font-mono text-sm text-fg">
          {release.version}
          {release.meta.tag && <span className="text-xs text-fg-muted">{release.meta.tag}</span>}
          {release.meta.bump && <span className="text-xs text-fg-muted">{release.meta.bump}</span>}
        </span>
        <span className="text-xs text-fg-muted">
          {release.meta.date ?? ""}
          {release.meta.reason ? ` · ${release.meta.reason}` : ""}
        </span>
      </div>
    </li>
  );
}

function ProductReleases() {
  const products = useProducts();
  const [productId, setProductId] = useState<string | null>(null);
  const [audience, setAudience] = useState<Audience>("users");
  const [who, setWho] = useWho();
  const current = productId ?? products.data?.[0]?.id ?? null;
  const detail = useProductReleases(current);
  const notes = useProductNotes(current ?? "");

  if (products.data && products.data.length === 0) return <Empty icon={<Package />} title="No products yet" hint="Group repos into a product in Portfolio, then draft one note across them." />;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Product">
          <Select value={current ?? ""} onChange={setProductId} options={(products.data ?? []).map((p) => ({ value: p.id, label: p.name }))} aria-label="Product" />
        </Field>
        <Field label="Audience">
          <SegTabs value={audience} onChange={setAudience} items={AUDIENCES.map((a) => ({ value: a, label: a }))} />
        </Field>
        <WhoPicker who={who} onChange={setWho} inline />
        <Button variant="primary" disabled={!current || notes.isPending} onClick={() => notes.mutate({ audience, ...who })}>
          {notes.isPending ? <Spinner /> : <Sparkles />}
          Draft combined notes
        </Button>
      </div>
      {detail.isLoading && <Spinner />}
      {detail.data && (
        <>
          <ul className="flex flex-col gap-1">
            {detail.data.repos.map((r) => (
              <li key={r.workspaceId} className="flex items-center gap-3 rounded-md border border-line px-3 py-2 text-sm">
                <span className="text-fg">{r.name}</span>
                <span className="text-xs text-fg-muted">{r.role}</span>
                <span className="ml-auto font-mono text-xs text-fg-muted">{r.latest ? `${r.latest.version}${r.latest.date ? ` · ${r.latest.date}` : ""}` : "no release yet"}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Combined notes</h3>
            {detail.data.notes.length === 0 && <p className="text-xs text-fg-muted">None yet. Draft them above; they are written in the first repo's releases/products/ folder.</p>}
            {detail.data.notes.map((n) => (
              <span key={n} className="font-mono text-xs text-fg">
                {n}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
