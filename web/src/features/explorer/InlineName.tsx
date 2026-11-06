import { useEffect, useRef, useState } from "react";
import { validateName } from "./tree";

/**
 * The inline text box for a new or renamed entry. Enter commits, Escape cancels, and leaving the box commits
 * only if what is typed is valid and changed. The reason a name is refused shows right under the box.
 */
export function InlineName({ initial, siblings, allowPath, current, onCommit, onCancel, depth }: { initial: string; siblings: readonly string[]; allowPath: boolean; current?: string; onCommit: (name: string) => void; onCancel: () => void; depth: number }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const error = value.trim() && value !== initial ? validateName(value, { siblings, allowPath, current }) : null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Renaming "app.config.ts" selects "app.config", so typing replaces the name and keeps the extension.
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (commit && name && name !== initial && !validateName(name, { siblings, allowPath, current })) onCommit(name);
    else onCancel();
  };

  return (
    <div className="relative flex h-full items-center pr-2" style={{ paddingLeft: 10 + depth * 14 + 18 }}>
      <input
        ref={ref}
        value={value}
        spellCheck={false}
        aria-label="Name"
        aria-invalid={!!error}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(true);
          else if (e.key === "Escape") finish(false);
        }}
        onBlur={() => finish(true)}
        className={`h-[20px] w-full min-w-0 rounded border bg-bg px-1.5 font-mono text-[12px] text-fg outline-none ${error ? "!border-red" : "!border-accent"}`}
      />
      {error && <div className="absolute left-6 top-[23px] z-30 max-w-[calc(100%-1.5rem)] rounded-md border border-red/40 bg-overlay px-2 py-1 text-[11px] text-red shadow-pop animate-slide-up">{error}</div>}
    </div>
  );
}
