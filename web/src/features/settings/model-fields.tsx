/**
 * Engine, model and effort as one row, shared by the pair editor and the agent editor. The model and effort
 * dropdowns follow the chosen engine; changing the engine keeps the model only when the new engine lists it.
 */
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Select, type Option } from "@/components/ui/form";
import { EffortSelect, ModelSelect } from "@/components/ui/model-select";
import { cachedCatalog, effortAfterEngineChange, hintValue, loadCatalog, modelAfterEngineChange } from "@/lib/models";
import type { EngineInfo } from "@/lib/types";
import { WarnNote } from "./shared";
import { EngineIcon } from "@/components/ui/engine-icon";

/** The engine/model/effort a change produces: the new engine, and what survives the switch. */
export function useEngineSwitch() {
  const qc = useQueryClient();
  return useCallback(
    async (prev: { model: string; effort: string }, engine: string): Promise<{ engine: string; model: string; effort: string }> => {
      if (!engine) return { engine, model: prev.model, effort: prev.effort }; // "inherit": nothing to judge a model against
      const next = cachedCatalog(qc, engine) ?? (await loadCatalog(qc, engine));
      return { engine, model: modelAfterEngineChange(prev.model, next), effort: effortAfterEngineChange(prev.effort, next?.efforts) };
    },
    [qc],
  );
}

export function engineOptions(engines: EngineInfo[], current: string, emptyLabel: string, emptyEngine?: string): Option[] {
  const withIcon = (id: string): Option["label"] => (
    <span className="flex items-center gap-2">
      <EngineIcon engine={id} className="size-3.5" />
      {id}
    </span>
  );
  const opts: Option[] = engines.map((e) => ({ value: e.id, label: withIcon(e.id), hint: !e.installed ? "not installed" : e.mcp === "none" ? "head only" : undefined }));
  if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: withIcon(current), hint: "unknown" });
  const empty: Option["label"] = emptyEngine ? (
    <span className="flex items-center gap-2">
      <EngineIcon engine={emptyEngine} className="size-3.5" />
      {emptyLabel}
    </span>
  ) : (
    emptyLabel
  );
  return [{ value: "", label: empty }, ...opts];
}

export function engineWarning(engines: EngineInfo[], id: string, asLead: boolean): string | null {
  if (!id) return null;
  const e = engines.find((x) => x.id === id);
  if (!e) return `Unknown engine "${id}".`;
  if (!e.installed) return `${e.label} is not installed on this machine.`;
  if (asLead && e.mcp === "none") return `${e.label} cannot lead a Hydra pair: trb's MCP tools are not wired for it. It can still run as a head.`;
  return null;
}

export interface Hints {
  engine?: string;
  model?: string;
  effort?: string;
}

export function EngineModelEffort({ engines, engine, effectiveEngine, model, effort, onChange, lead, emptyEngineLabel = "inherit", hints }: { engines: EngineInfo[]; engine: string; /** The engine that will actually run when `engine` is blank (inherited): its list drives the model and effort pickers. */ effectiveEngine?: string; model: string; effort: string; lead?: boolean; emptyEngineLabel?: string; hints?: Hints; onChange: (p: { engine: string; model: string; effort: string }) => void }) {
  const switchEngine = useEngineSwitch();
  const warn = engineWarning(engines, engine, !!lead);
  const listEngine = engine || effectiveEngine || "";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[150px_1fr_100px] gap-2">
        <Select
          value={engine}
          onChange={(v) => void switchEngine({ model, effort }, v).then(onChange)}
          options={engineOptions(engines, engine, hints?.engine ? `${emptyEngineLabel} · ${hintValue(hints.engine)}` : emptyEngineLabel, hints?.engine ? effectiveEngine : undefined)}
          aria-label="Engine"
        />
        <ModelSelect engine={listEngine} value={model} onChange={(m) => onChange({ engine, model: m, effort })} inheritedHint={hints?.model} placeholder="Engine default" disabledReason="Pick an engine to choose a model for it. A model id only means something to one engine." />
        <EffortSelect engine={listEngine} model={model} value={effort} onChange={(e) => onChange({ engine, model, effort: e })} inheritedHint={hints?.effort} />
      </div>
      {warn && <WarnNote>{warn}</WarnNote>}
    </div>
  );
}
