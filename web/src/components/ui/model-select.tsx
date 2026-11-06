/**
 * Model and effort pickers, fed by the daemon's per-engine catalog.
 *
 *  - <ModelSelect>   a field that opens a searchable, grouped list (<ModelPicker>) of the engine's models.
 *  - <ModelPicker>   the list itself, for hosts that provide their own trigger (the composer's chip).
 *  - <EffortSelect>  the reasoning levels the engine (and, for codex, the model) supports.
 *
 * A list is only a convenience. Whatever is typed can be used as a custom model, because a model ships before any
 * list notices it; a value the list does not know is kept and shown with a "custom" badge, never discarded.
 */
import * as React from "react";
import { Select as S } from "radix-ui";
import { Check, ChevronDown, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { customRow, effortChoices, hintValue, effortOptions, isCustomModel, searchModels, useModels, type ModelInfo } from "@/lib/models";
import { EngineIcon, ModelIcon } from "./engine-icon";
import { Badge, Skeleton, Spinner } from "./misc";
import { Popover, Tooltip } from "./overlay";

/* ----------------------------------------------------------------- the list */

type Row = { kind: "default" } | { kind: "model"; m: ModelInfo } | { kind: "custom"; value: string };

export interface ModelPickerProps {
  engine: string;
  value: string;
  onChange: (model: string) => void;
  /** Called after a choice, so a popover host can close. */
  onDone?: () => void;
  allowDefault?: boolean;
  /** Label of the "no choice" row. */
  defaultLabel?: string;
  /** Read-only: rows copy the id instead of choosing it (the engines page). */
  onPick?: (model: ModelInfo) => void;
  autoFocus?: boolean;
  maxHeight?: number;
}

export function ModelPicker({ engine, value, onChange, onDone, allowDefault = true, defaultLabel = "Default (the engine's own)", onPick, autoFocus = true, maxHeight = 300 }: ModelPickerProps) {
  const { catalog, isLoading, refreshing, refresh, error } = useModels(engine);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  const models = catalog?.models ?? [];
  const search = React.useMemo(() => searchModels(models, query), [models, query]);
  const custom = onPick ? null : customRow(query, models);

  const rows = React.useMemo<Row[]>(() => {
    const r: Row[] = [];
    if (allowDefault && !onPick && (!query.trim() || /^def/i.test(query.trim()))) r.push({ kind: "default" });
    for (const g of search.groups) for (const m of g.items) r.push({ kind: "model", m });
    if (custom) r.push({ kind: "custom", value: custom });
    return r;
  }, [allowDefault, onPick, query, search, custom]);

  // Start on the best match while searching, on the current value otherwise.
  React.useEffect(() => {
    if (query.trim()) setActive(rows.findIndex((r) => r.kind === "model") >= 0 ? rows.findIndex((r) => r.kind === "model") : 0);
    else {
      const at = rows.findIndex((r) => (r.kind === "model" ? r.m.id === value : r.kind === "default" && !value));
      setActive(at >= 0 ? at : 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, models.length]);

  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "model" && onPick) return onPick(row.m);
    onChange(row.kind === "default" ? "" : row.kind === "model" ? row.m.id : row.value);
    onDone?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home" && e.ctrlKey) {
      setActive(0);
    } else if (e.key === "End" && e.ctrlKey) {
      setActive(rows.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Shift-Enter takes the typed text as-is, even when the list has near matches.
      if (e.shiftKey && custom) choose({ kind: "custom", value: custom });
      else choose(rows[active]);
    }
  };

  let rowIndex = -1;
  const optionClass = (i: number, selected: boolean) =>
    cn("pop-row flex w-full cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] outline-none", i === active ? "bg-active" : "hover:bg-hover", selected && "text-fg");

  return (
    <div className="flex flex-col">
      <input
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={models.length ? `Search ${models.length} models…` : "Search or type a model id…"}
        spellCheck={false}
        role="combobox"
        aria-expanded
        aria-controls="model-list"
        aria-activedescendant={`model-row-${active}`}
        aria-label="Search models"
        className="mb-1 h-8 w-full rounded-md border border-line bg-raised px-2.5 font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-fg-faint focus:border-accent/70"
        style={{ outline: "none" }}
      />

      {catalog?.error && (
        <p className="mb-1 flex items-start gap-1.5 rounded-md bg-amber/10 px-2 py-1.5 text-[11px] leading-snug text-amber">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          <span>
            Couldn't list models: {catalog.error}
            {catalog.source === "static" ? " Showing the built-in list." : " Showing the last list."}
          </span>
        </p>
      )}
      {error && !catalog && <p className="mb-1 rounded-md bg-red/10 px-2 py-1.5 text-[11px] text-red">Couldn't reach the daemon: {error.message}</p>}

      <div id="model-list" ref={listRef} role="listbox" aria-label="Models" style={{ maxHeight }} className="overflow-y-auto">
        {isLoading && !catalog ? (
          <div className="flex flex-col gap-1.5 p-1" aria-busy>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        ) : (
          <>
            {rows[0]?.kind === "default" && (() => {
              rowIndex++;
              const i = rowIndex;
              return (
                <button key="default" id={`model-row-${i}`} data-row={i} data-active={i === active} role="option" aria-selected={!value} onMouseMove={() => setActive(i)} onClick={() => choose({ kind: "default" })} className={optionClass(i, !value)}>
                  <Check className={cn("size-3.5 shrink-0 text-accent", value && "opacity-0")} />
                  <EngineIcon engine={engine} className="size-4" />
                  <span className="flex-1 text-fg-muted">{defaultLabel}</span>
                </button>
              );
            })()}
            {search.groups.map((g, gi) => (
              <div key={g.group ?? `g${gi}`}>
                {search.grouped && g.group && <div className="sticky top-0 z-10 bg-overlay px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">{g.group}</div>}
                {g.items.map((m) => {
                  rowIndex++;
                  const i = rowIndex;
                  const selected = m.id === value;
                  return (
                    <button key={m.id} id={`model-row-${i}`} data-row={i} data-active={i === active} role="option" aria-selected={selected} title={m.hint} onMouseMove={() => setActive(i)} onClick={() => choose({ kind: "model", m })} className={optionClass(i, selected)}>
                      {!onPick && <Check className={cn("size-3.5 shrink-0 text-accent", !selected && "opacity-0")} />}
                      <ModelIcon model={m.id} engine={engine} className="size-4" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs">{m.id}</span>
                        {(m.label !== m.id || (!search.grouped && m.group)) && (
                          <span className="block truncate text-[10.5px] text-fg-faint">
                            {m.label !== m.id ? m.label : ""}
                            {!search.grouped && m.group ? `${m.label !== m.id ? " · " : ""}${m.group}` : ""}
                          </span>
                        )}
                      </span>
                      {m.default && <Badge tone="accent">default</Badge>}
                      {onPick && m.efforts && m.efforts.length > 0 && <span className="shrink-0 font-mono text-[10px] text-fg-faint">{m.efforts.join(" · ")}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            {search.more > 0 && <div className="px-2 py-1.5 text-center text-[11px] text-fg-faint">{search.more.toLocaleString()} more. Keep typing to narrow it.</div>}
            {!models.length && !isLoading && !custom && <div className="px-2 py-3 text-center text-xs text-fg-muted">No models listed. Type a model id to use it.</div>}
            {models.length > 0 && query.trim() && search.total === 0 && !custom && <div className="px-2 py-3 text-center text-xs text-fg-muted">No model matches “{query.trim()}”.</div>}
          </>
        )}
      </div>

      {custom && (
        <div className="mt-1 border-t border-line pt-1">
          {(() => {
            const i = rows.length - 1;
            return (
              <button id={`model-row-${i}`} data-row={i} data-active={i === active} role="option" aria-selected={false} onMouseMove={() => setActive(i)} onClick={() => choose({ kind: "custom", value: custom })} className={optionClass(i, false)}>
                <ModelIcon model={custom} engine={engine} className="size-4" />
                <span className="flex-1 truncate">
                  Use <span className="font-mono text-xs text-accent">“{custom}”</span> as a custom model
                </span>
                <kbd className="rounded border border-line bg-raised px-1 font-mono text-[9px] text-fg-faint">⇧↵</kbd>
              </button>
            );
          })()}
        </div>
      )}

      <div className="mt-1 flex items-center gap-2 border-t border-line px-2 pt-1.5 text-[10.5px] text-fg-faint">
        <span className="min-w-0 flex-1 truncate">{catalog ? `${catalog.models.length.toLocaleString()} model${catalog.models.length === 1 ? "" : "s"} · ${catalog.source === "cli" ? "from the CLI" : "built-in"}` : isLoading ? "Loading…" : ""}</span>
        <button type="button" onClick={() => void refresh()} disabled={refreshing || !engine} aria-label="Refresh the model list" title="Ask the engine for its models again" className="flex size-5 items-center justify-center rounded text-fg-faint outline-none hover:bg-hover hover:text-fg disabled:opacity-50">
          {refreshing ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ the field */

export interface ModelSelectProps {
  engine: string;
  value: string;
  onChange: (model: string) => void;
  /** Shown (muted) when nothing is chosen. */
  placeholder?: string;
  /** When nothing is chosen but something will still apply: "from agent “Reviewer”: haiku". */
  inheritedHint?: string;
  allowDefault?: boolean;
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
  /** Why it is disabled, shown on hover. */
  disabledReason?: string;
  ariaLabel?: string;
}

export function ModelSelect({ engine, value, onChange, placeholder = "Default", inheritedHint, allowDefault = true, size = "md", className, disabled, disabledReason, ariaLabel = "Model" }: ModelSelectProps) {
  const [open, setOpen] = React.useState(false);
  const { catalog } = useModels(open || value ? engine : null);
  const custom = isCustomModel(value, catalog);
  const trigger = (
    <button
      type="button"
      disabled={disabled || !engine}
      aria-label={`${ariaLabel}: ${value || inheritedHint || placeholder}`}
      aria-haspopup="listbox"
      className={cn("flex w-full items-center justify-between gap-2 rounded-md border border-line bg-raised px-2.5 text-left outline-none transition-colors hover:border-line-strong focus-visible:border-accent/70 disabled:cursor-not-allowed disabled:opacity-50", size === "sm" ? "h-7 text-xs" : "h-8 text-[13px]", className)}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {engine && <ModelIcon model={value || "default"} engine={engine} className="size-3.5" />}
        {value ? (
          <span className="truncate font-mono text-xs">{value}</span>
        ) : (
          <span className={cn("truncate text-xs", inheritedHint ? "italic text-fg-faint" : "text-fg-muted")}>{inheritedHint || placeholder}</span>
        )}
        {value && custom && <Badge title="Not in the engine's list: used as typed">custom</Badge>}
      </span>
      <ChevronDown className="size-3.5 shrink-0 text-fg-faint" />
    </button>
  );
  const field = (
    <Popover open={open} onOpenChange={setOpen} width={348} trigger={trigger}>
      {open && <ModelPicker engine={engine} value={value} onChange={onChange} onDone={() => setOpen(false)} allowDefault={allowDefault} />}
    </Popover>
  );
  if (disabled || !engine) {
    const reason = disabledReason ?? (!engine ? "Pick an engine first" : undefined);
    return reason ? (
      <Tooltip label={reason} side="top">
        <span className="block w-full">{field}</span>
      </Tooltip>
    ) : (
      field
    );
  }
  return field;
}

/* -------------------------------------------------------------- effort */

const DEFAULT_SENTINEL = "__default__";

export interface EffortSelectProps {
  engine: string;
  model: string;
  value: string;
  onChange: (effort: string) => void;
  inheritedHint?: string;
  size?: "sm" | "md";
  className?: string;
  ariaLabel?: string;
}

export function EffortSelect({ engine, model, value, onChange, inheritedHint, size = "md", className, ariaLabel = "Effort" }: EffortSelectProps) {
  const { catalog } = useModels(engine || null);
  const loaded = !engine || !!catalog;
  const options = effortOptions(engine ? catalog : undefined, model);
  // An engine with no effort control: nothing to choose, and a stored value cannot be honoured, so say so.
  const none = !!engine && !!catalog && options.length === 0 && !value;
  const choices = effortChoices(options, value);

  const trigger = (
    <S.Root value={value || DEFAULT_SENTINEL} onValueChange={(v) => onChange(v === DEFAULT_SENTINEL ? "" : v)} disabled={none}>
      <S.Trigger aria-label={`${ariaLabel}: ${value || inheritedHint || "default"}`} className={cn("flex w-full items-center justify-between gap-2 rounded-md border border-line bg-raised px-2.5 text-left outline-none transition-colors hover:border-line-strong focus-visible:border-accent/70 disabled:cursor-not-allowed disabled:opacity-50", size === "sm" ? "h-7 text-xs" : "h-8 text-[13px]", className)}>
        <span title={!value ? inheritedHint : undefined} className={cn("truncate text-xs", !value && (inheritedHint ? "italic text-fg-faint" : "text-fg-muted"))}>{value || hintValue(inheritedHint) || "default"}</span>
        <S.Icon>{loaded ? <ChevronDown className="size-3.5 text-fg-faint" /> : <Spinner className="size-3" />}</S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} className="pop-surface z-[95] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line-strong p-1 text-[12.5px] text-fg">
          <S.Viewport>
            {[DEFAULT_SENTINEL, ...choices].map((v) => (
              <S.Item key={v} value={v} className="pop-row relative flex cursor-default select-none items-center gap-2 rounded-lg py-1.5 pl-7 pr-2 outline-none data-[highlighted]:bg-active">
                <S.ItemIndicator className="absolute left-2">
                  <Check className="pop-check size-3.5 text-accent" />
                </S.ItemIndicator>
                <S.ItemText>{v === DEFAULT_SENTINEL ? "default" : v}</S.ItemText>
                {v !== DEFAULT_SENTINEL && !options.includes(v) && <span className="ml-auto pl-3 text-[10px] text-fg-faint">not listed</span>}
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
  return none ? (
    <Tooltip label="This engine has no reasoning-effort control" side="top">
      <span className="block w-full">{trigger}</span>
    </Tooltip>
  ) : (
    trigger
  );
}

/**
 * Effort as a bar: "default" first, then each level. Drag, click or use the arrow keys to pick a stop. The fill
 * grows with the level and a highlight sweeps across it, faster at higher levels (see .effort-sweep). Both are
 * transforms, so they stay on the compositor. Same choices and value as EffortSelect.
 */
export function EffortSlider({ engine, model, value, onChange, inheritedHint, className, ariaLabel = "Effort" }: Omit<EffortSelectProps, "size">) {
  const { catalog } = useModels(engine || null);
  const loaded = !engine || !!catalog;
  const options = effortOptions(engine ? catalog : undefined, model);
  // An engine with no effort control: the bar is inert, and a stored value cannot be honoured, so say so.
  const none = !!engine && !!catalog && options.length === 0 && !value;
  const levels = ["", ...effortChoices(options, value)];
  const last = levels.length - 1;
  const index = Math.max(0, levels.indexOf(value));
  const frac = last ? index / last : 0;
  const shown = value || hintValue(inheritedHint) || "default";
  const bar = React.useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = React.useState(false);

  const stopAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(frac * last);
  };
  const pick = (i: number) => {
    if (levels[i] !== value) onChange(levels[i]!);
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (none || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    pick(stopAt(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) pick(stopAt(e.clientX));
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const to: Record<string, number> = { ArrowLeft: index - 1, ArrowDown: index - 1, ArrowRight: index + 1, ArrowUp: index + 1, Home: 0, End: last };
    const i = to[e.key];
    if (none || i === undefined) return;
    e.preventDefault();
    pick(Math.min(last, Math.max(0, i)));
  };

  const control = (
    <div
      ref={bar}
      role="slider"
      tabIndex={none ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={shown}
      aria-disabled={none || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={onKeyDown}
      className={cn("relative flex h-4 min-w-0 flex-1 touch-none select-none items-center rounded-sm outline-none", none ? "cursor-not-allowed opacity-50" : "cursor-pointer")}
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-raised">
        <div className="absolute inset-y-0 left-0 w-full origin-left overflow-hidden rounded-full bg-accent transition-transform duration-150 ease-out" style={{ transform: `scaleX(${frac})`, "--level": frac } as React.CSSProperties}>
          {/* "default" (index 0) has no fill to sweep across. */}
          {index > 0 && <span aria-hidden className="effort-sweep" />}
        </div>
      </div>
      <div
        className={cn("absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-overlay transition-[left,transform] duration-150 ease-out", dragging && "scale-125")}
        style={{ left: `${last ? (index / last) * 100 : 0}%` }}
      />
    </div>
  );
  const row = (
    <div className={cn("flex min-w-0 flex-1 items-center gap-2", className)}>
      {control}
      <span title={!value ? inheritedHint : undefined} className={cn("flex w-14 shrink-0 items-center justify-end gap-1.5 truncate text-right font-mono text-xs", !value && "text-fg-muted", !value && inheritedHint && "italic")}>
        {!loaded && <Spinner className="size-3" />}
        <span className="truncate">{shown}</span>
      </span>
    </div>
  );
  return none ? (
    <Tooltip label="This engine has no reasoning-effort control" side="top">
      <span className="flex min-w-0 flex-1">{row}</span>
    </Tooltip>
  ) : (
    row
  );
}

/** Model then effort, as two grid cells. The engine select stays with the caller (its options differ by page). */
export function ModelEffortFields({ engine, model, effort, onChange, modelHint, effortHint, size = "md" }: { engine: string; model: string; effort: string; onChange: (patch: { model?: string; effort?: string }) => void; modelHint?: string; effortHint?: string; size?: "sm" | "md" }) {
  return (
    <>
      <ModelSelect engine={engine} value={model} onChange={(m) => onChange({ model: m })} inheritedHint={modelHint} placeholder="Engine default" size={size} />
      <EffortSelect engine={engine} model={model} value={effort} onChange={(e) => onChange({ effort: e })} inheritedHint={effortHint} size={size} />
    </>
  );
}
