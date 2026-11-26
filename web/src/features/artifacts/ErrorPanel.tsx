import { Copy, ExternalLink, Lock, RefreshCw, Terminal, Trash2, TriangleAlert, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/misc";
import { MIN_CLAUDE_VERSION, openExternal, type AccountStatus, type ArtifactError } from "./data";

function copyClaudeUpdate() {
  void navigator.clipboard.writeText("claude update").then(() => toast.success("Copied claude update"));
}

/** Account-level banner shown once over the artifact list while cached items stay readable. */
export function AccountBanner({
  account,
  onRefresh,
  refreshing,
}: {
  account: AccountStatus;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  if (account.state === "ok" || account.state === "unknown") return null;

  if (account.state === "not_signed_in") {
    return (
      <div className="flex items-start gap-2 border-b border-line bg-amber/[0.06] p-3 text-xs">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">Claude Code is not signed in to claude.ai</div>
          <div className="mt-0.5 leading-relaxed text-fg-muted">
            Artifacts live in a claude.ai account, so TreeBoss can't read or refresh them. Run{" "}
            <span className="font-mono">/login</span> in Claude Code and pick your claude.ai account, then refresh. The list below is from the last read.
          </div>
        </div>
        <Button variant="subtle" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={refreshing ? "animate-spin-fast" : undefined} />
          Refresh
        </Button>
      </div>
    );
  }

  if (account.state === "no_plan") {
    return (
      <div className="flex items-start gap-2 border-b border-line bg-amber/[0.06] p-3 text-xs">
        <Lock className="mt-0.5 size-3.5 shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">Your plan does not include artifacts</div>
          <div className="mt-0.5 leading-relaxed text-fg-muted">
            claude.ai turned down this account for artifacts. Check which plan the account Claude Code uses is on.
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => openExternal("https://claude.ai")}>
              <ExternalLink />
              Open claude.ai
            </Button>
            <Button variant="subtle" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className={refreshing ? "animate-spin-fast" : undefined} />
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 border-b border-line bg-amber/[0.06] p-3 text-xs">
      <Terminal className="mt-0.5 size-3.5 shrink-0 text-amber" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg">Claude Code is too old for artifacts</div>
        <div className="mt-0.5 leading-relaxed text-fg-muted">
          Artifacts need Claude Code <span className="font-mono">{MIN_CLAUDE_VERSION}</span> or newer. This machine has{" "}
          <span className="font-mono">{account.version ?? "unknown"}</span>.
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={copyClaudeUpdate}>
            <Copy />
            <span>
              Copy <span className="font-mono">claude update</span>
            </span>
          </Button>
          <Button variant="subtle" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={refreshing ? "animate-spin-fast" : undefined} />
            Check again
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Per-artifact error shown in the detail preview pane. */
export function ErrorPanel({
  error,
  errorText,
  url,
  version,
  onRetry,
  onRemove,
  retrying,
}: {
  error: ArtifactError;
  errorText: string | null;
  url: string;
  version: string | null;
  onRetry: () => void;
  onRemove: () => void;
  retrying: boolean;
}) {
  if (error === "no_plan") {
    return (
      <Empty
        icon={<Lock />}
        title="Your plan does not include artifacts"
        hint="claude.ai turned down this account for artifacts. Check which plan the account Claude Code uses is on."
        action={
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            <Button variant="outline" onClick={() => openExternal("https://claude.ai")}>
              <ExternalLink />
              Open claude.ai
            </Button>
            <Button variant="subtle" onClick={onRetry} disabled={retrying}>
              <RefreshCw className={retrying ? "animate-spin-fast" : undefined} />
              Try again
            </Button>
          </div>
        }
        className="h-full"
      />
    );
  }

  if (error === "too_old") {
    return (
      <Empty
        icon={<Terminal />}
        title="Claude Code is too old for artifacts"
        hint={
          <>
            Artifacts need Claude Code <span className="font-mono">{MIN_CLAUDE_VERSION}</span> or newer. This machine has{" "}
            <span className="font-mono">{version ?? "unknown"}</span>.
          </>
        }
        action={
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" onClick={copyClaudeUpdate}>
              <Copy />
              <span>
                Copy <span className="font-mono">claude update</span>
              </span>
            </Button>
            <Button variant="subtle" onClick={onRetry} disabled={retrying}>
              <RefreshCw className={retrying ? "animate-spin-fast" : undefined} />
              Check again
            </Button>
          </div>
        }
        className="h-full"
      />
    );
  }

  if (error === "no_access") {
    return (
      <Empty
        icon={<UserRound />}
        title="You don't have access to this artifact"
        hint="It may be private, or the owner stopped sharing it. Ask them for a new link."
        action={
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            <Button variant="outline" onClick={() => openExternal(url)}>
              <ExternalLink />
              Open in claude.ai
            </Button>
            <Button variant="dangerGhost" onClick={onRemove}>
              <Trash2 />
              Remove from list
            </Button>
          </div>
        }
        className="h-full"
      />
    );
  }

  if (error === "not_signed_in") {
    return (
      <Empty
        icon={<TriangleAlert />}
        title="Claude Code is not signed in to claude.ai"
        hint={
          <>
            Artifacts live in a claude.ai account, so TreeBoss can't read or refresh them. Run <span className="font-mono">/login</span> in Claude Code and pick your claude.ai account, then refresh.
          </>
        }
        action={
          <div className="mt-2 flex items-center justify-center">
            <Button variant="subtle" onClick={onRetry} disabled={retrying}>
              <RefreshCw className={retrying ? "animate-spin-fast" : undefined} />
              Refresh
            </Button>
          </div>
        }
        className="h-full"
      />
    );
  }

  const trimmed = (errorText ?? "Could not read this artifact.").slice(0, 300);
  return (
    <Empty
      icon={<TriangleAlert />}
      title="Couldn't read this artifact"
      hint={trimmed}
      action={
        <div className="mt-2 flex items-center justify-center">
          <Button variant="subtle" onClick={onRetry} disabled={retrying}>
            <RefreshCw className={retrying ? "animate-spin-fast" : undefined} />
            Try again
          </Button>
        </div>
      }
      className="h-full"
    />
  );
}
