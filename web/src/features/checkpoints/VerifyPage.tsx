/**
 * Settings > Verification: when and how the project's checks run after a turn. Global defaults (off unless turned on),
 * then a per-workspace override. Whether one session verifies is a small toggle on the strip above the composer.
 *
 *   GET/PUT /api/verify/config            the global settings
 *   GET/PUT /api/workspaces/:id/verify    one workspace's override, and what would be detected there
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, put } from "@/lib/api";
import { useWorkspaces } from "@/lib/queries";
import { useUi } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Skeleton, Spinner } from "@/components/ui/misc";
import { PageShell } from "@/features/settings/shared";
import { commandsToText, fromTri, textToCommands, tri, type VerifyScopeConfig } from "./logic";

interface GlobalReply {
  config: VerifyScopeConfig;
}
interface WorkspaceReply {
  config: VerifyScopeConfig;
  global: VerifyScopeConfig;
  detected: Array<{ name: string; cmd: string }>;
}

const body = (d: { enabled: boolean | null; retries: string; timeout: string; cmds: string }) => ({
  enabled: d.enabled,
  max_retries: d.retries.trim() === "" ? null : Number(d.retries),
  timeout_sec: d.timeout.trim() === "" ? null : Number(d.timeout),
  commands: d.cmds.trim() ? textToCommands(d.cmds) : null,
});

const seed = (c: VerifyScopeConfig) => ({
  retries: c.max_retries === null ? "" : String(c.max_retries),
  timeout: c.timeout_sec === null ? "" : String(c.timeout_sec),
  cmds: commandsToText(c.commands),
});

function Card({ title, help, children, attr }: { title: string; help?: React.ReactNode; children: React.ReactNode; attr: string }) {
  return (
    <section {...{ [attr]: "" }} className="flex flex-col gap-3 rounded-xl border border-line bg-raised/40 p-4">
      <div>
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {help && <p className="mt-0.5 max-w-[62ch] text-xs leading-relaxed text-fg-muted">{help}</p>}
      </div>
      {children}
    </section>
  );
}

function Numbers({ retries, timeout, setRetries, setTimeout: setT, retriesPlaceholder, timeoutPlaceholder }: { retries: string; timeout: string; setRetries: (v: string) => void; setTimeout: (v: string) => void; retriesPlaceholder: string; timeoutPlaceholder: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Max auto-fix retries" hint="Failed checks are sent back to the agent this many times per message. 0 never retries (max 10).">
        <Input inputMode="numeric" value={retries} onChange={(e) => setRetries(e.target.value)} placeholder={retriesPlaceholder} data-verify-retries aria-label="Max automatic fix retries" />
      </Field>
      <Field label="Timeout per command (seconds)" hint="A command still running after this is stopped and counts as failed.">
        <Input inputMode="numeric" value={timeout} onChange={(e) => setT(e.target.value)} placeholder={timeoutPlaceholder} data-verify-timeout aria-label="Command timeout in seconds" />
      </Field>
    </div>
  );
}

const CMD_PLACEHOLDER = "typecheck: bun run typecheck\ntest: bun test";

function GlobalCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["verify-global"], queryFn: () => get<GlobalReply>("/api/verify/config") });
  const [enabled, setEnabled] = useState(false);
  const [retries, setRetries] = useState("");
  const [timeout, setTimeoutSec] = useState("");
  const [cmds, setCmds] = useState("");
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!q.data || seeded) return;
    setSeeded(true);
    const c = q.data.config;
    setEnabled(c.enabled === true);
    const s = seed(c);
    setRetries(s.retries);
    setTimeoutSec(s.timeout);
    setCmds(s.cmds);
  }, [q.data, seeded]);
  const save = useMutation({
    mutationFn: () => put("/api/verify/config", body({ enabled, retries, timeout, cmds })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["verify-global"] });
      void qc.invalidateQueries({ queryKey: ["verify-ws"] });
      void qc.invalidateQueries({ queryKey: ["verify"] });
      toast.success("Verification defaults saved");
    },
    onError: (e: Error) => toast.error("Could not save", { description: e.message }),
  });

  return (
    <Card attr="data-verify-global" title="Defaults for every workspace" help="Off unless you turn it on. When on, the project's checks run after each turn and failures go back to the agent. A workspace below can override any of this.">
      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          <label className="flex items-center gap-3 text-[13px]">
            <Switch checked={enabled} onChange={setEnabled} label="Verify after every turn (global default)" />
            <span>Verify after every turn</span>
            <span className="text-xs text-fg-faint">{enabled ? "on by default" : "off by default"}</span>
          </label>
          <Numbers retries={retries} timeout={timeout} setRetries={setRetries} setTimeout={setTimeoutSec} retriesPlaceholder="2" timeoutPlaceholder="300" />
          <Field label="Command override" hint="One per line, as `name: command`. Empty: the checks are detected from the project (typecheck, lint, test scripts).">
            <Textarea rows={3} value={cmds} onChange={(e) => setCmds(e.target.value)} spellCheck={false} placeholder={CMD_PLACEHOLDER} className="font-mono text-[12px]" data-verify-commands aria-label="Global verify commands" />
          </Field>
          <div className="flex justify-end">
            <Button size="sm" variant="primary" data-verify-save="global" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Spinner />} Save defaults
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function WorkspaceForm({ wsId }: { wsId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["verify-ws", wsId], queryFn: () => get<WorkspaceReply>(`/api/workspaces/${wsId}/verify`) });
  const [enabled, setEnabled] = useState("inherit");
  const [retries, setRetries] = useState("");
  const [timeout, setTimeoutSec] = useState("");
  const [cmds, setCmds] = useState("");
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!q.data || seeded) return;
    setSeeded(true);
    setEnabled(tri(q.data.config.enabled));
    const s = seed(q.data.config);
    setRetries(s.retries);
    setTimeoutSec(s.timeout);
    setCmds(s.cmds);
  }, [q.data, seeded]);
  const save = useMutation({
    mutationFn: () => put(`/api/workspaces/${wsId}/verify`, body({ enabled: fromTri(enabled), retries, timeout, cmds })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["verify-ws", wsId] });
      void qc.invalidateQueries({ queryKey: ["verify"] });
      toast.success("Workspace verification saved");
    },
    onError: (e: Error) => toast.error("Could not save", { description: e.message }),
  });
  if (q.isLoading) return <Skeleton className="h-24 w-full" />;
  if (q.error) return <p className="text-xs text-red">{(q.error as Error).message}</p>;
  const globalOn = q.data?.global.enabled === true;
  const detected = q.data?.detected ?? [];
  return (
    <>
      <Field label="Verification in this workspace">
        <Select size="sm" value={enabled} onChange={setEnabled} options={[{ value: "inherit", label: `Inherit (global default: ${globalOn ? "on" : "off"})` }, { value: "on", label: "On" }, { value: "off", label: "Off" }]} aria-label="Verification for this workspace" />
      </Field>
      <Numbers retries={retries} timeout={timeout} setRetries={setRetries} setTimeout={setTimeoutSec} retriesPlaceholder="inherit" timeoutPlaceholder="inherit" />
      <Field label="Commands" hint={detected.length ? `Empty inherits the global override, else what was detected here: ${detected.map((c) => c.cmd).join(", ")}.` : "One per line, as `name: command`. Empty inherits the global override, else nothing runs."}>
        <Textarea rows={3} value={cmds} onChange={(e) => setCmds(e.target.value)} spellCheck={false} placeholder={CMD_PLACEHOLDER} className="font-mono text-[12px]" data-verify-ws-commands aria-label="Workspace verify commands" />
      </Field>
      <div className="flex justify-end">
        <Button size="sm" variant="primary" data-verify-save="workspace" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Spinner />} Save workspace
        </Button>
      </div>
    </>
  );
}

function WorkspaceCard() {
  const workspaces = useWorkspaces();
  const current = useUi((s) => s.current);
  const [picked, setPicked] = useState<string | null>(null);
  const list = workspaces.data ?? [];
  const wsId = picked ?? (current && list.some((w) => w.id === current) ? current : (list[0]?.id ?? null));
  return (
    <Card attr="data-verify-workspace" title="Override for one workspace" help="Choose a workspace and set what differs there. Anything left on inherit follows the defaults above.">
      {!list.length ? (
        <p className="text-xs text-fg-muted">No workspaces yet.</p>
      ) : (
        <>
          <Field label="Workspace">
            <Select size="sm" value={wsId ?? ""} onChange={setPicked} options={list.map((w) => ({ value: w.id, label: w.name, hint: w.path }))} aria-label="Workspace" />
          </Field>
          {wsId && <WorkspaceForm key={wsId} wsId={wsId} />}
        </>
      )}
    </Card>
  );
}

export function VerifyPage() {
  return (
    <PageShell title="Verification" description="Run the project's checks (typecheck, lint, tests) after each turn, and send failures back to the agent before the session counts as done. Turn it on or off for one session from the strip above the composer.">
      <GlobalCard />
      <WorkspaceCard />
    </PageShell>
  );
}
