/**
 * Promise-based dialogs: `await confirm({...})`, `await ask({...})`. Mounted once by the shell. Replaces
 * window.confirm/prompt, which look foreign, block the page, and cannot be styled or tested.
 */
import * as React from "react";
import { create } from "zustand";
import { Dialog } from "./overlay";
import { Button } from "./button";
import { Input } from "./form";

type Pending =
  | { kind: "confirm"; title: string; description?: string; confirmLabel: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: "ask"; title: string; description?: string; label?: string; initial: string; placeholder?: string; confirmLabel: string; validate?: (v: string) => string | null; resolve: (v: string | null) => void };

const useDialogStore = create<{ pending: Pending | null; set(p: Pending | null): void }>((set) => ({ pending: null, set: (pending) => set({ pending }) }));

export function confirm(o: { title: string; description?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => useDialogStore.getState().set({ kind: "confirm", title: o.title, description: o.description, confirmLabel: o.confirmLabel ?? "Confirm", danger: o.danger ?? false, resolve }));
}

export function ask(o: { title: string; description?: string; label?: string; initial?: string; placeholder?: string; confirmLabel?: string; validate?: (v: string) => string | null }): Promise<string | null> {
  return new Promise((resolve) => useDialogStore.getState().set({ kind: "ask", title: o.title, description: o.description, label: o.label, initial: o.initial ?? "", placeholder: o.placeholder, confirmLabel: o.confirmLabel ?? "OK", validate: o.validate, resolve }));
}

export function DialogHost() {
  const { pending, set } = useDialogStore();
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (pending?.kind === "ask") {
      setValue(pending.initial);
      setError(null);
    }
  }, [pending]);

  if (!pending) return null;
  const close = (result: boolean | string | null) => {
    (pending.resolve as (v: any) => void)(result);
    set(null);
  };

  if (pending.kind === "confirm") {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && close(false)}
        title={pending.title}
        description={pending.description}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant={pending.danger ? "danger" : "primary"} autoFocus onClick={() => close(true)}>
              {pending.confirmLabel}
            </Button>
          </>
        }
      />
    );
  }

  const submit = () => {
    const err = pending.validate?.(value) ?? null;
    if (err) return setError(err);
    close(value);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close(null)}
      title={pending.title}
      description={pending.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            {pending.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {pending.label && <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">{pending.label}</span>}
        <Input
          autoFocus
          value={value}
          placeholder={pending.placeholder}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onFocus={(e) => e.currentTarget.select()}
        />
        {error && <span className="text-[11px] text-red">{error}</span>}
      </div>
    </Dialog>
  );
}
