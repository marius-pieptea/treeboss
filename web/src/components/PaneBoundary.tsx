import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  /** Human name of the pane, shown in the card ("Browser", "Agent"...). */
  name: string;
  children: ReactNode;
}
interface State {
  error: Error | null;
  /** Bumped on reload so the subtree remounts from scratch. */
  attempt: number;
}

/** Test seam: `localStorage["trb.test.crash"] = "<pane name>"` makes that pane throw while rendering. */
function Crasher({ name }: { name: string }): null {
  try {
    if (localStorage.getItem("trb.test.crash") === name) throw new Error(`Test crash in ${name}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Test crash")) throw e;
  }
  return null;
}

/** One pane crashing must not blank the app: show what broke and let the operator reload just that pane. */
export class PaneBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[pane crashed] ${this.props.name}:`, error, info.componentStack);
  }

  render() {
    const { error, attempt } = this.state;
    if (error) {
      return (
        <div role="alert" data-testid="pane-crashed" className="flex h-full items-center justify-center overflow-auto bg-bg p-6">
          <div className="w-full max-w-md rounded-lg border border-red/30 bg-red/5 p-4">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-red">
              <AlertTriangle className="size-4 shrink-0" />
              This pane crashed: {this.props.name}
            </div>
            <p className="mt-1.5 text-xs text-fg-muted">The rest of the app is fine. Reloading the pane starts it again from scratch.</p>
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-raised p-2 font-mono text-[11px] text-fg-muted">{error.message || String(error)}</pre>
            <Button variant="primary" size="sm" className="mt-3" onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}>
              <RotateCw /> Reload pane
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div key={attempt} className="h-full min-h-0">
        <Crasher name={this.props.name} />
        {this.props.children}
      </div>
    );
  }
}
