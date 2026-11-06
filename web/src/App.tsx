import { lazy, Suspense, useEffect, useState } from "react";
import { onSignedOut } from "@/lib/api";
import { usePath } from "@/lib/nav";
import { Home } from "@/shell/Home";
import { Shell } from "@/shell/Shell";
import { Logo } from "@/shell/Logo";

// The compact view for a paired phone: its own entry, loaded only there.
const RemoteApp = lazy(() => import("@/remote/RemoteApp").then((m) => ({ default: m.RemoteApp })));

function SignedOut({ onBack }: { onBack: () => void }) {
  const [checking, setChecking] = useState(false);
  const [tries, setTries] = useState(0);
  const probe = async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/workspaces", { credentials: "same-origin" });
      if (r.ok) return onBack();
    } catch {}
    setChecking(false);
    setTries((n) => n + 1);
  };
  // The daemon may just be restarting, or `trb ui` may have signed this origin in from elsewhere: keep asking.
  useEffect(() => {
    const t = setInterval(probe, 3000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <div className="max-w-sm animate-slide-up text-center">
        <Logo size={40} className="mx-auto mb-5" />
        <h1 className="text-[17px] font-semibold">Session expired</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
          This tab lost its sign-in on {location.host}. Checking again every few seconds{tries > 1 ? `, ${tries} tries so far` : ""}. It comes back on its own once the daemon answers with your session.
        </p>
        <button onClick={probe} disabled={checking} className="mt-4 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg disabled:opacity-60">
          {checking ? "Checking…" : "Retry now"}
        </button>
        <p className="mt-5 text-[12px] text-fg-muted">Still stuck? Run <code className="text-accent">trb ui</code> to open a fresh signed-in tab.</p>
      </div>
    </div>
  );
}

export function App() {
  const path = usePath();
  if (path === "/remote" || path.startsWith("/remote/")) return <Suspense fallback={null}><RemoteApp /></Suspense>;
  return <OwnerApp path={path} />;
}

function OwnerApp({ path }: { path: string }) {
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => onSignedOut(() => setSignedOut(true)), []);
  if (signedOut) return <SignedOut onBack={() => location.reload()} />;
  const m = /^\/w\/(w_[A-Za-z0-9]+)/.exec(path);
  return m ? <Shell key={m[1]} workspaceId={m[1]} /> : <Home />;
}
