import { useEffect, useState } from "react";
import { FileDown, Loader2, LogIn, LogOut, Pencil, Play, Plus, Server, Trash2, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/overlay";
import { Switch } from "@/components/ui/form";
import { Badge, Empty, Skeleton } from "@/components/ui/misc";
import { ask, confirm } from "@/components/ui/dialogs";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { McpServer } from "@/lib/types";
import { api, keys, useAction, useMcp, type ProbeResult } from "./data";
import { joinArgs } from "./logic";
import { McpEditorDialog, McpImportDialog } from "./McpDialogs";
import { Masked, PageShell } from "./shared";
import { CodegraphMcpRow } from "@/features/codegraph/McpBuiltinRow";
import { EvidenceMcpRows } from "@/features/evidence/McpRows";
import { DIALOG_PAGE, useSettingsUi } from "./ui-state";

const SESSION_TOOLS = ["subagent_create", "subagent_send", "subagent_wait", "subagent_list", "subagent_interrupt", "subagent_close", "subagent_merge"];

type TestState = { running: true } | { running: false; result: ProbeResult };

function TestResult({ result, onDismiss }: { result: ProbeResult; onDismiss: () => void }) {
  const [all, setAll] = useState(false);
  const tools = all ? result.tools : result.tools.slice(0, 10);
  return (
    <div className={cn("mt-3 min-w-0 overflow-hidden rounded-lg border p-3 text-xs animate-slide-up", result.ok ? "border-green/25 bg-green/5" : "border-red/30 bg-red/5")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {result.ok ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-green">Connected</span>
              <span className="font-mono text-fg-muted">
                {result.server?.name} {result.server?.version}
              </span>
              <Badge tone="green">
                {result.tools.length} tool{result.tools.length === 1 ? "" : "s"}
              </Badge>
              <span className="font-mono text-fg-faint">{result.latencyMs} ms</span>
            </div>
          ) : (
            <div className="font-medium text-red">{result.error ?? "No answer"}</div>
          )}
          {result.ok && result.error && <div className="mt-1 text-amber">{result.error}</div>}
        </div>
        <button onClick={onDismiss} aria-label="Dismiss result" className="text-fg-faint outline-none hover:text-fg">
          <X className="size-3.5" />
        </button>
      </div>
      {result.stderrTail && (
        <pre className="mt-2 max-h-32 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px] leading-relaxed text-fg-muted" aria-label="Server's stderr">
          {result.stderrTail}
        </pre>
      )}
      {result.ok && result.tools.length > 0 && (
        <ul className="mt-2 grid min-w-0 grid-cols-1 gap-1">
          {tools.map((t) => (
            <li key={t.name} className="flex min-w-0 gap-2">
              <span className="shrink-0 font-mono text-[11px] font-medium text-accent">{t.name}</span>
              <span className="min-w-0 truncate text-fg-muted" title={t.description}>
                {t.description.split("\n")[0]}
              </span>
            </li>
          ))}
          {result.tools.length > tools.length && (
            <li>
              <button onClick={() => setAll(true)} className="text-fg-muted underline-offset-2 hover:text-fg hover:underline">
                Show all {result.tools.length}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function ServerCard({ s, test, signingIn, onTest, onDismiss, onEdit, onDelete, onToggle, onSignIn, onSignOut, delay }: { s: McpServer; test?: TestState; signingIn: boolean; onTest: () => void; onDismiss: () => void; onEdit: () => void; onDelete: () => void; onToggle: (on: boolean) => void; onSignIn: () => void; onSignOut: () => void; delay: number }) {
  const envCount = Object.keys(s.env).length;
  const headerCount = Object.keys(s.headers).length;
  const running = test && test.running;
  const signedIn = !!s.oauth?.signedIn;
  // The prominent button only once a test showed the server wants it; otherwise it waits in the hover actions.
  const wantsSignIn = s.transport === "http" && !signedIn && test && !test.running && test.result.authRequired;
  return (
    <div style={{ animationDelay: `${delay}ms` }} className={cn("group min-w-0 animate-slide-up rounded-xl border border-line bg-bg/40 p-3.5 transition-colors hover:border-line-strong", !s.enabled && "opacity-60")}>
      <div className="flex items-center gap-3">
        <Switch checked={s.enabled} onChange={onToggle} label={`${s.name} enabled`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[13px] font-semibold">{s.name}</span>
            <Badge tone={s.transport === "http" ? "blue" : "neutral"}>{s.transport}</Badge>
            {envCount > 0 && <Badge title={Object.keys(s.env).join(", ")}>{envCount} env</Badge>}
            {headerCount > 0 && <Badge title={Object.keys(s.headers).join(", ")}>{headerCount} header{headerCount === 1 ? "" : "s"}</Badge>}
            {signedIn && (
              <Badge tone="green" title={[s.oauth?.scope ? `Scope: ${s.oauth.scope}` : null, s.oauth?.expiresAt ? `Token refreshes after ${new Date(s.oauth.expiresAt).toLocaleString()}` : null].filter(Boolean).join("\n") || undefined}>
                signed in
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-fg-muted" title={s.transport === "stdio" ? [s.command, joinArgs(s.args)].join(" ") : (s.url ?? "")}>
            {s.transport === "stdio" ? [s.command, joinArgs(s.args)].filter(Boolean).join(" ") : s.url}
          </div>
        </div>
        {(wantsSignIn || signingIn) && (
          <Button variant="outline" size="sm" onClick={onSignIn} disabled={signingIn} aria-label={`Sign in to ${s.name}`}>
            {signingIn ? <Loader2 className="animate-spin-fast" /> : <LogIn />}
            {signingIn ? "Waiting for sign-in…" : "Sign in"}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onTest} disabled={!!running} aria-label={`Test ${s.name}`}>
          {running ? <Loader2 className="animate-spin-fast" /> : <Play />}
          {running ? "Testing…" : "Test"}
        </Button>
        <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {s.transport === "http" && !wantsSignIn && !signingIn && (
            <IconButton label={signedIn ? "Sign out" : "Sign in (OAuth)"} size="icon-sm" onClick={signedIn ? onSignOut : onSignIn}>
              {signedIn ? <LogOut /> : <LogIn />}
            </IconButton>
          )}
          <IconButton label="Edit" size="icon-sm" onClick={onEdit}>
            <Pencil />
          </IconButton>
          <IconButton label="Delete" size="icon-sm" variant="dangerGhost" onClick={onDelete}>
            <Trash2 />
          </IconButton>
        </div>
      </div>
      {test && !test.running && <TestResult result={test.result} onDismiss={onDismiss} />}
      {(envCount > 0 || headerCount > 0) && (
        <details className="mt-2 text-xs text-fg-muted">
          <summary className="cursor-pointer select-none text-fg-faint hover:text-fg-muted">Show {envCount > 0 ? "environment" : "headers"}</summary>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {Object.entries(envCount > 0 ? s.env : s.headers).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-fg-faint">{k}</dt>
                <dd className="min-w-0 truncate">
                  <Masked text={v} />
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

export function McpPage() {
  const q = useMcp();
  const dialog = useSettingsUi((s) => s.dialog);
  const closeDialog = useSettingsUi((s) => s.close);
  const [editor, setEditor] = useState<{ server: McpServer | null } | null>(null);
  const [importer, setImporter] = useState<"claude" | "file" | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  useEffect(() => {
    if (!dialog || DIALOG_PAGE[dialog] !== "mcp") return;
    if (dialog === "mcp-add") setEditor({ server: null });
    if (dialog === "mcp-import") setImporter("claude");
    closeDialog();
  }, [dialog, closeDialog]);

  const toggle = useAction((a: { name: string; on: boolean }) => api.mcp.toggle(a.name, a.on), { invalidate: [keys.mcp] });
  const remove = useAction((name: string) => api.mcp.remove(name), { invalidate: [keys.mcp], success: (_r, n) => `Removed ${n}` });

  const runTest = async (name: string) => {
    setTests((t) => ({ ...t, [name]: { running: true } }));
    try {
      const result = await api.mcp.test(name);
      setTests((t) => ({ ...t, [name]: { running: false, result } }));
    } catch (e: any) {
      setTests((t) => ({ ...t, [name]: { running: false, result: { name, ok: false, transport: "stdio", tools: [], latencyMs: 0, error: e.message } } }));
    }
  };

  // Names waiting on the browser, with when they started. Polled until the daemon reports the token, or given up on.
  const [signingIn, setSigningIn] = useState<Record<string, number>>({});
  const waiting = Object.keys(signingIn);
  useEffect(() => {
    if (!waiting.length) return;
    const t = setInterval(() => q.refetch(), 2000);
    return () => clearInterval(t);
  }, [waiting.length, q]);
  useEffect(() => {
    for (const name of waiting) {
      const s = q.data?.find((x) => x.name === name);
      const done = !!s?.oauth?.signedIn;
      if (!done && Date.now() - signingIn[name]! < 5 * 60_000) continue;
      setSigningIn(({ [name]: _, ...rest }) => rest);
      if (done) {
        toast.success(`Signed in to ${name}`);
        void runTest(name);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  const signIn = async (s: McpServer) => {
    // Opened before any await, while the click still counts as a user gesture, so popup blockers let it through.
    const win = window.open("about:blank", "_blank");
    try {
      let r: { authorizeUrl: string };
      try {
        r = await api.mcp.signIn(s.name);
      } catch (e: any) {
        // The authorization server does not let apps register themselves: the operator brings a client.
        if (!/client ID/i.test(String(e?.message))) throw e;
        const clientId = await ask({ title: `Client ID for ${s.name}`, description: e.message, label: "Client ID", confirmLabel: "Continue", validate: (v) => (v.trim() ? null : "Enter the client ID.") });
        if (!clientId) return void win?.close();
        const clientSecret = await ask({ title: `Client secret for ${s.name}`, description: "Leave it empty for a public client.", label: "Client secret", confirmLabel: "Sign in" });
        if (clientSecret === null) return void win?.close();
        r = await api.mcp.signIn(s.name, { clientId: clientId.trim(), clientSecret: clientSecret.trim() || undefined });
      }
      if (win && !win.closed) win.location.href = r.authorizeUrl;
      else if (!window.open(r.authorizeUrl, "_blank")) toast(`Open the sign-in page for ${s.name}`, { action: { label: "Open", onClick: () => window.open(r.authorizeUrl, "_blank") }, duration: 60_000 });
      setSigningIn((m) => ({ ...m, [s.name]: Date.now() }));
    } catch (e: any) {
      win?.close();
      toast.error(e?.message ?? String(e));
    }
  };

  const signOut = async (s: McpServer) => {
    try {
      await api.mcp.signOut(s.name);
      toast.success(`Signed out of ${s.name}`);
      q.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  const del = async (s: McpServer) => {
    if (await confirm({ title: `Remove ${s.name}?`, description: "Sessions stop seeing its tools from their next turn.", confirmLabel: "Remove", danger: true })) remove.mutate(s.name);
  };

  const servers = q.data ?? [];
  const afterSave = (names: string[]) => {
    setEditor(null);
    setImporter(null);
    q.refetch();
    if (names.length) toast.success(`Saved ${names.join(", ")}`);
  };

  return (
    <PageShell
      title="MCP servers"
      description="The tools your agents can call. For claude this list is the whole tool surface (so a session's tools are the same every run); other engines layer it on top of their own configuration."
      actions={
        <>
          <DropdownMenu
            align="end"
            trigger={
              <Button variant="outline" size="md">
                <FileDown /> Import
              </Button>
            }
            entries={[
              { label: "From Claude config", onSelect: () => setImporter("claude") },
              { label: "From another file…", onSelect: () => setImporter("file") },
            ]}
          />
          <Button variant="primary" size="md" onClick={() => setEditor({ server: null })}>
            <Plus /> Add server
          </Button>
        </>
      }
    >
      <div className="rounded-xl border border-line bg-raised/40 p-3.5 animate-slide-up">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-semibold">trb</span>
          <Badge tone="accent">built in</Badge>
          <span className="text-xs text-fg-muted">Always on for sessions that may open subagents.</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {SESSION_TOOLS.map((t) => (
            <span key={t} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted">
              {t}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-2.5 grid gap-2.5 empty:hidden">
        <CodegraphMcpRow />
        <EvidenceMcpRows />
      </div>

      {q.isLoading ? (
        <div className="grid gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : servers.length === 0 ? (
        <Empty icon={<Server />} title="No MCP servers" hint="Add one, paste a snippet from its README, or import the ones you already use with Claude." className="rounded-xl border border-dashed border-line py-10" />
      ) : (
        <div className="grid gap-2.5">
          {servers.map((s, i) => (
            <ServerCard key={s.name} s={s} delay={i * 30} test={tests[s.name]} onTest={() => runTest(s.name)} onDismiss={() => setTests(({ [s.name]: _x, ...rest }) => rest)} onEdit={() => setEditor({ server: s })} onDelete={() => del(s)} onToggle={(on) => toggle.mutate({ name: s.name, on })} signingIn={s.name in signingIn} onSignIn={() => signIn(s)} onSignOut={() => signOut(s)} />
          ))}
        </div>
      )}

      <McpEditorDialog open={!!editor} editing={editor?.server ?? null} existing={servers.map((s) => s.name)} onClose={() => setEditor(null)} onDone={afterSave} />
      <McpImportDialog open={!!importer} initialSource={importer ?? "claude"} onClose={() => setImporter(null)} onDone={(added) => afterSave(added)} />
    </PageShell>
  );
}
