import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form";
import { Badge, SegTabs, Spinner } from "@/components/ui/misc";
import { useDebounced } from "@/lib/hooks";
import type { McpServer } from "@/lib/types";
import { api } from "./data";
import { joinArgs, parseMcpPaste, tokenizeArgs, type ParsedMcpServer } from "./logic";
import { ErrorNote, KeyValueEditor, WarnNote, kvToRecord, recordToKv, type KV } from "./shared";

const NAME = /^[A-Za-z0-9_-]{1,40}$/;

interface FormState {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  env: KV[];
  url: string;
  headers: KV[];
}

const blank = (): FormState => ({ name: "", transport: "stdio", command: "", args: "", env: [], url: "", headers: [] });

function fromServer(s: McpServer): FormState {
  return { name: s.name, transport: s.transport, command: s.command ?? "", args: joinArgs(s.args), env: recordToKv(s.env), url: s.url ?? "", headers: recordToKv(s.headers) };
}

export function validateMcpForm(f: FormState, editing: boolean): string | null {
  if (!editing) {
    if (!NAME.test(f.name)) return 'A name is 1-40 letters, digits, "_" or "-".';
    if (f.name === "trb") return '"trb" is reserved: trb injects its own server under that name.';
  }
  if (f.transport === "stdio") return f.command.trim() ? null : "A stdio server needs a command.";
  if (!/^https?:\/\//i.test(f.url.trim())) return "The url must start with http:// or https://.";
  return null;
}

/** Add or edit one server, by form or by pasting a JSON snippet. */
export function McpEditorDialog({ open, editing, existing, onClose, onDone }: { open: boolean; editing: McpServer | null; existing: string[]; onClose: () => void; onDone: (names: string[]) => void }) {
  const [tab, setTab] = useState<"form" | "paste">("form");
  const [form, setForm] = useState<FormState>(blank());
  const [paste, setPaste] = useState("");
  const [names, setNames] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab("form");
    setForm(editing ? fromServer(editing) : blank());
    setPaste("");
    setNames({});
    setError(null);
    setTouched(false);
  }, [open, editing]);

  const parsed = useMemo(() => parseMcpPaste(paste), [paste]);
  const resolvedName = (s: ParsedMcpServer, i: number) => s.name ?? names[i] ?? "";
  const pasteProblems = parsed.servers.map((s, i) => (NAME.test(resolvedName(s, i)) && resolvedName(s, i) !== "trb" ? null : "needs a valid name"));
  const set = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));
  const formError = validateMcpForm(form, !!editing);
  const argChips = tokenizeArgs(form.args);

  const submitForm = async () => {
    setTouched(true);
    if (formError) return;
    setBusy(true);
    setError(null);
    try {
      const body = form.transport === "stdio" ? { command: form.command.trim(), args: tokenizeArgs(form.args), env: kvToRecord(form.env), url: null, headers: {} } : { command: null, args: [], env: {}, url: form.url.trim(), headers: kvToRecord(form.headers) };
      if (editing) await api.mcp.edit(editing.name, body);
      else await api.mcp.add({ name: form.name, ...body });
      onDone([form.name]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submitPaste = async () => {
    setBusy(true);
    setError(null);
    const done: string[] = [];
    try {
      for (let i = 0; i < parsed.servers.length; i++) {
        const s = parsed.servers[i];
        await api.mcp.add({ name: resolvedName(s, i), command: s.command ?? null, args: s.args, env: s.env, url: s.url ?? null, headers: s.headers });
        done.push(resolvedName(s, i));
      }
      onDone(done);
    } catch (e: any) {
      setError(`${done.length ? `Added ${done.join(", ")}, then: ` : ""}${e.message}`);
      if (done.length) onDone(done);
    } finally {
      setBusy(false);
    }
  };

  const canPaste = parsed.servers.length > 0 && pasteProblems.every((p) => !p);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={600}
      title={editing ? `Edit ${editing.name}` : "Add MCP server"}
      description={editing ? "Changes apply to the next turn of every session." : "The server is started by the engine when a turn begins, and stopped when it ends."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {tab === "form" ? (
            <Button variant="primary" disabled={busy} onClick={submitForm}>
              {busy ? "Saving…" : editing ? "Save changes" : "Add server"}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || !canPaste} onClick={submitPaste}>
              {busy ? "Adding…" : `Add ${parsed.servers.length || ""} server${parsed.servers.length === 1 ? "" : "s"}`}
            </Button>
          )}
        </>
      }
    >
      <div className="flex max-h-[60vh] flex-col gap-3.5 overflow-y-auto pr-1">
        {!editing && (
          <SegTabs
            value={tab}
            onChange={setTab}
            items={[
              { value: "form", label: "Form" },
              { value: "paste", label: "Paste JSON" },
            ]}
          />
        )}

        {tab === "form" ? (
          <>
            <Field label="Name" hint={editing ? "The name is the identity; to rename, add a new server and delete this one." : "The tools appear to agents as mcp__<name>__<tool>."}>
              <Input value={form.name} onChange={(e) => set({ name: e.target.value })} disabled={!!editing} placeholder="context7" spellCheck={false} autoFocus={!editing} className="font-mono" />
            </Field>
            <SegTabs
              value={form.transport}
              onChange={(t) => set({ transport: t })}
              items={[
                { value: "stdio", label: "Local command (stdio)" },
                { value: "http", label: "Remote (HTTP)" },
              ]}
            />
            {form.transport === "stdio" ? (
              <>
                <Field label="Command">
                  <Input value={form.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" spellCheck={false} className="font-mono" />
                </Field>
                <Field label="Arguments" hint="Quote anything with spaces: --root 'my folder'">
                  <Input value={form.args} onChange={(e) => set({ args: e.target.value })} placeholder="-y @upstash/context7-mcp" spellCheck={false} className="font-mono" />
                </Field>
                {argChips.length > 0 && (
                  <div className="-mt-1.5 flex flex-wrap gap-1" aria-label="How the arguments will be split">
                    {argChips.map((a, i) => (
                      <span key={i} className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
                        {a || "''"}
                      </span>
                    ))}
                  </div>
                )}
                <Field label="Environment">
                  <KeyValueEditor rows={form.env} onChange={(env) => set({ env })} addLabel="Add variable" />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL">
                  <Input value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://mcp.example.com/mcp" spellCheck={false} className="font-mono" />
                </Field>
                <Field label="Headers" hint="Credentials go here, e.g. Authorization: Bearer …">
                  <KeyValueEditor rows={form.headers} onChange={(headers) => set({ headers })} keyPlaceholder="Header" addLabel="Add header" />
                </Field>
              </>
            )}
            {touched && formError && <ErrorNote>{formError}</ErrorNote>}
          </>
        ) : (
          <>
            <Field label="Paste a server definition" hint='Accepts {"mcpServers": {…}}, an editor-style {"servers": {…}}, a name → server map, or a single server.'>
              <Textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'{\n  "mcpServers": {\n    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }\n  }\n}'} spellCheck={false} autoFocus className="min-h-40 font-mono text-xs" />
            </Field>
            {parsed.errors.map((e, i) => (
              <ErrorNote key={i}>{e}</ErrorNote>
            ))}
            {parsed.warnings.map((w, i) => (
              <WarnNote key={i}>{w}</WarnNote>
            ))}
            {parsed.servers.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Found</span>
                {parsed.servers.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-lg border border-line bg-raised/50 px-2.5 py-1.5 animate-slide-up">
                    {s.name ? <span className="w-32 shrink-0 truncate font-mono text-xs font-medium">{s.name}</span> : <Input value={names[i] ?? ""} onChange={(e) => setNames({ ...names, [i]: e.target.value })} placeholder="name this server" className="h-6 w-32 shrink-0 font-mono text-xs" aria-label="Server name" />}
                    <Badge tone={s.url ? "blue" : "neutral"}>{s.url ? "http" : "stdio"}</Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">{s.url ?? [s.command, ...s.args].join(" ")}</span>
                    {existing.includes(resolvedName(s, i)) && <Badge tone="amber" title="A server with this name exists and will be replaced">replaces</Badge>}
                    {pasteProblems[i] && <Badge tone="red">{pasteProblems[i]}</Badge>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Dialog>
  );
}

/** Preview, then import, the servers in a Claude config or any file with an `mcpServers` object. */
export function McpImportDialog({ open, initialSource, onClose, onDone }: { open: boolean; initialSource: "claude" | "file"; onClose: () => void; onDone: (added: string[]) => void }) {
  const [source, setSource] = useState<"claude" | "file">(initialSource);
  const [path, setPath] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setSource(initialSource);
      setPath("");
      setOverwrite(false);
      setError(null);
    }
  }, [open, initialSource]);

  const debouncedPath = useDebounced(path.trim(), 350);
  const from = source === "claude" ? "claude" : debouncedPath;
  const preview = useQuery({
    queryKey: ["mcp-import-preview", from, overwrite],
    enabled: open && (source === "claude" || !!from),
    queryFn: () => api.mcp.importFrom(from, { overwrite, dryRun: true }),
    retry: false,
  });

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.mcp.importFrom(from, { overwrite });
      onDone(r.added);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const p = preview.data;
  const names = p ? Object.keys(p.servers) : [];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={600}
      title="Import MCP servers"
      description="Copies the servers across; nothing is removed from the source."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !p || p.added.length === 0} onClick={run}>
            {busy ? "Importing…" : p ? `Import ${p.added.length}` : "Import"}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[58vh] flex-col gap-3 overflow-y-auto pr-1">
        <SegTabs
          value={source}
          onChange={setSource}
          items={[
            { value: "claude", label: "Claude config (~/.claude.json)" },
            { value: "file", label: "Another file" },
          ]}
        />
        {source === "file" && <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/project/.mcp.json" spellCheck={false} autoFocus className="font-mono" aria-label="File path" />}
        {preview.isFetching && (
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Spinner /> Reading…
          </div>
        )}
        {preview.error && <ErrorNote>{(preview.error as Error).message}</ErrorNote>}
        {p && !preview.isFetching && (
          <>
            <div className="font-mono text-[11px] text-fg-faint">{p.file}</div>
            {names.length === 0 && p.invalid.length === 0 && <div className="text-xs text-fg-muted">No mcpServers found in that file.</div>}
            <div className="flex flex-col gap-1.5">
              {names.map((n) => (
                <div key={n} className="flex items-center gap-2 rounded-lg border border-line bg-raised/50 px-2.5 py-1.5">
                  <span className="w-32 shrink-0 truncate font-mono text-xs font-medium">{n}</span>
                  <Badge tone={p.servers[n].transport === "http" ? "blue" : "neutral"}>{p.servers[n].transport}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">{p.servers[n].target}</span>
                  {p.added.includes(n) ? <Badge tone="green">{overwrite && p.skipped.length === 0 ? "import" : "new"}</Badge> : <Badge tone="amber">skip: exists</Badge>}
                </div>
              ))}
              {p.invalid.map((n) => (
                <div key={n} className="flex items-center gap-2 rounded-lg border border-red/30 bg-red/5 px-2.5 py-1.5">
                  <span className="w-32 shrink-0 truncate font-mono text-xs">{n}</span>
                  <span className="flex-1 text-[11px] text-red">not a valid server (needs a command or a url, and a plain name)</span>
                </div>
              ))}
            </div>
            {(p.skipped.length > 0 || overwrite) && (
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox checked={overwrite} onChange={setOverwrite} label="Replace servers that already exist" />
                Replace servers that already exist
              </label>
            )}
          </>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Dialog>
  );
}
