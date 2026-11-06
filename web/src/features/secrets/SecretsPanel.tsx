import { useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/dialogs";
import { Field, Input } from "@/components/ui/form";
import { Empty, SegTabs, Skeleton } from "@/components/ui/misc";
import { useWorkspace } from "@/lib/workspace";
import { ago } from "@/lib/utils";
import { useSecretActions, useSecretEnvs, useSecretKeys } from "./data";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** A secret being set (a new name) or replaced (an existing name). The value lives here only until it is saved. */
interface Draft {
  key: string | null;
  name: string;
  value: string;
}

/** The environments of the workspace as tabs, and the selected one's secret names. Values are typed in and never shown again. */
export function SecretsPanel() {
  const { workspace } = useWorkspace();
  const ws = workspace.id;
  const envs = useSecretEnvs(ws);
  const [env, setEnv] = useState("dev");
  const current = envs.data?.find((e) => e.name === env);
  const keys = useSecretKeys(ws, env);
  const actions = useSecretActions(ws);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [addingEnv, setAddingEnv] = useState<string | null>(null);

  const saveSecret = () => {
    if (!draft || !NAME.test(draft.name.trim()) || !draft.value) return;
    actions.setSecret.mutate({ env, key: draft.name.trim(), value: draft.value }, { onSuccess: () => setDraft(null) });
  };

  const deleteSecret = async (key: string) => {
    const ok = await confirm({ title: `Delete ${key}?`, description: `It is removed from ${env} here. Other environments are not touched.`, confirmLabel: "Delete", danger: true });
    if (ok) actions.unsetSecret.mutate({ env, key });
  };

  const submitEnv = () => {
    const name = (addingEnv ?? "").trim().toLowerCase();
    if (!ENV_NAME.test(name)) return;
    actions.addEnv.mutate({ name }, { onSuccess: () => { setEnv(name); setAddingEnv(null); } });
  };

  const removeEnv = async () => {
    if (!current || current.builtin) return;
    const ok = await confirm({ title: `Remove ${env}?`, description: `Its ${current.secrets} secret${current.secrets === 1 ? "" : "s"} are deleted too.`, confirmLabel: "Remove", danger: true });
    if (!ok) return;
    actions.removeEnv.mutate({ name: env }, { onSuccess: () => setEnv("dev") });
  };

  return (
    <section className="flex flex-col gap-3 p-3" aria-label="Environments and secrets">
      <div className="flex items-center gap-2">
        {envs.isLoading ? (
          <Skeleton className="h-7 w-48" />
        ) : (
          <SegTabs
            value={env}
            onChange={setEnv}
            items={(envs.data ?? []).map((e) => ({ value: e.name, label: e.name, badge: e.secrets }))}
          />
        )}
        {addingEnv === null ? (
          <Button variant="ghost" size="sm" aria-label="Add environment" onClick={() => setAddingEnv("")}>
            <Plus /> Environment
          </Button>
        ) : (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              submitEnv();
            }}
          >
            <Input autoFocus value={addingEnv} onChange={(e) => setAddingEnv(e.target.value)} placeholder="qa" spellCheck={false} className="h-7 w-28 font-mono" aria-label="Environment name" />
            <Button type="submit" variant="subtle" size="sm" disabled={!ENV_NAME.test(addingEnv.trim().toLowerCase())}>
              Add
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAddingEnv(null)}>
              Cancel
            </Button>
          </form>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span className="font-mono">{current?.url ?? "No URL"}</span>
        {current && !current.builtin && (
          <Button variant="dangerGhost" size="sm" onClick={removeEnv}>
            <Trash2 /> Remove {env}
          </Button>
        )}
      </div>

      {keys.isLoading ? (
        <Skeleton className="h-16" />
      ) : keys.data?.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel" aria-label={`Secrets in ${env}`}>
          {keys.data.map((k) => (
            <li key={k.key} className="flex items-center gap-3 px-3 py-2">
              <KeyRound className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono">{k.key}</div>
                <div className="text-xs text-fg-faint">updated {ago(k.updatedAt)}</div>
              </div>
              <span className="font-mono tracking-widest text-fg-faint" aria-label="value hidden">
                ••••••••
              </span>
              <Button variant="ghost" size="sm" aria-label={`Replace ${k.key}`} onClick={() => setDraft({ key: k.key, name: k.key, value: "" })}>
                Replace
              </Button>
              <Button variant="dangerGhost" size="sm" aria-label={`Delete ${k.key}`} onClick={() => deleteSecret(k.key)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon={<KeyRound />} title={`No secrets in ${env}`} hint="Values are encrypted on this machine and are never shown again." />
      )}

      {draft ? (
        <form
          className="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveSecret();
          }}
        >
          <Field label="Name">
            <Input autoFocus={draft.key === null} disabled={draft.key !== null} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="DATABASE_URL" spellCheck={false} autoComplete="off" className="font-mono" />
          </Field>
          <Field label={draft.key ? `New value for ${draft.key}` : "Value"} hint="Stored encrypted. Type it once; it is not shown again.">
            <Input autoFocus={draft.key !== null} type="password" autoComplete="new-password" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} className="font-mono" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!NAME.test(draft.name.trim()) || !draft.value || actions.setSecret.isPending}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="subtle" size="sm" onClick={() => setDraft({ key: null, name: "", value: "" })}>
            <Plus /> Add secret
          </Button>
        </div>
      )}
    </section>
  );
}
