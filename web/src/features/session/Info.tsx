import { useQuery } from "@tanstack/react-query";
import { get, url } from "@/lib/api";
import { ago, money, tokens } from "@/lib/utils";
import type { GitLogEntry, SessionView, TurnRow } from "@/lib/types";
import { Badge, StatusDot } from "@/components/ui/misc";
import { durationSec, engineLabel, formatElapsed } from "@/features/heads/model";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 border-b border-line/60 py-1.5 text-[12.5px]">
      <dt className="text-fg-muted">{k}</dt>
      <dd className="min-w-0 break-all font-mono text-[12px]">{children}</dd>
    </div>
  );
}

export function Info({ session }: { session: SessionView }) {
  const turns = useQuery({ queryKey: ["session", session.id, "turns"], queryFn: () => get<{ turns: TurnRow[] }>(url.session(session.id, "turns")).then((r) => r.turns), refetchInterval: session.status === "running" ? 4000 : false });
  const log = useQuery({ queryKey: ["session", session.id, "gitlog"], enabled: session.isolation === "worktree" && session.status !== "closed", retry: false, queryFn: () => get<{ commits: GitLogEntry[] }>(url.git(session.id, "log", { limit: 12 })).then((r) => r.commits) });

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <dl className="max-w-[760px]">
        <Row k="Status">
          <span className="flex items-center gap-2">
            <StatusDot status={session.status} /> {session.status}
            {session.error && <span className="text-red">· {session.error.split("\n")[0]}</span>}
          </span>
        </Row>
        <Row k="Engine">{engineLabel(session)}</Row>
        <Row k="Role">{session.role ?? "none"}</Row>
        <Row k="Agent">{session.agent ?? "none"}</Row>
        <Row k="Skills">{session.skills === null || session.skills === undefined ? "all enabled" : session.skills.length ? session.skills.join(", ") : "none"}</Row>
        <Row k="Pair">{session.pair ?? "none"}</Row>
        <Row k="Depth">{session.depth === 0 ? "lead" : `head, level ${session.depth}`}</Row>
        <Row k="Isolation">{session.isolation === "worktree" ? "own git worktree" : "shared workspace"}</Row>
        <Row k="Branch">{session.branch ?? "—"}</Row>
        <Row k="Directory">{session.cwd}</Row>
        <Row k="Turns">{session.turns}</Row>
        <Row k="Usage">
          {tokens(session.tokens.input + session.tokens.cache_read)} in · {tokens(session.tokens.output)} out{session.cost_usd ? ` · ${money(session.cost_usd)}` : ""}
        </Row>
      </dl>

      <h3 className="mb-1.5 mt-6 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Turns</h3>
      <div className="max-w-[760px] overflow-hidden rounded-lg border border-line">
        <table className="w-full text-[12px]">
          <thead className="bg-raised text-left text-[10.5px] uppercase tracking-wide text-fg-faint">
            <tr>
              <th className="px-3 py-1.5 font-medium">#</th>
              <th className="px-3 py-1.5 font-medium">Status</th>
              <th className="px-3 py-1.5 font-medium">Started</th>
              <th className="px-3 py-1.5 font-medium">Took</th>
              <th className="px-3 py-1.5 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {turns.data?.map((t) => {
              const d = durationSec(t.started_at, t.finished_at);
              return (
                <tr key={t.id} className="border-t border-line/60">
                  <td className="px-3 py-1.5 font-mono text-fg-muted">{t.seq}</td>
                  <td className="px-3 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <StatusDot status={t.status} size={6} /> {t.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-fg-muted">{ago(t.started_at)} ago</td>
                  <td className="px-3 py-1.5 font-mono">{d === null ? "…" : formatElapsed(d)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{t.cost_usd ? money(t.cost_usd) : "—"}</td>
                </tr>
              );
            })}
            {!turns.data?.length && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-fg-faint">
                  No turns yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {log.data && log.data.length > 0 && (
        <>
          <h3 className="mb-1.5 mt-6 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Commits on this branch</h3>
          <ul className="max-w-[760px] divide-y divide-line/60 rounded-lg border border-line">
            {log.data.map((c) => (
              <li key={c.sha} className="flex items-center gap-3 px-3 py-1.5 text-[12.5px]">
                <span className="font-mono text-[11px] text-accent">{c.short}</span>
                <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                {c.refs.slice(0, 2).map((r) => (
                  <Badge key={r}>{r.replace("HEAD -> ", "")}</Badge>
                ))}
                <span className="text-[11px] text-fg-faint">{ago(c.date)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
