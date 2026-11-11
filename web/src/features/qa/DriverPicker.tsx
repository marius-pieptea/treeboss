import { useState } from "react";
import { Bot, ChevronDown, Network } from "lucide-react";
import { agentFromWho } from "./run-choice";
import { getWho, WhoPicker } from "@/components/agent-who";
import { Button } from "@/components/ui/button";
import { ModelIcon } from "@/components/ui/engine-icon";
import { Field, Select } from "@/components/ui/form";
import { Popover } from "@/components/ui/overlay";
import { PairChipInner, PairList, RunTabs, type RunTab } from "@/features/agent/RunWith";
import { useAgents, usePairs } from "@/lib/queries";
import type { Driver } from "./api";

type AgentDriver = Extract<Driver, { kind: "agent" }>;

export function DriverPicker({ driver, onChange, disabled }: { driver: Driver; onChange: (d: Driver) => void; disabled?: boolean }) {
  const pairsQ = usePairs();
  const agents = useAgents();
  const [tab, setTab] = useState<RunTab>(driver.kind === "pair" ? "hydra" : "harness");
  const pair = driver.kind === "pair" ? (pairsQ.data ?? []).find((p) => p.id === driver.pairId) : undefined;
  const agent: AgentDriver = driver.kind === "agent" ? driver : { kind: "agent" };

  const chip = (
    <Button variant="outline" size="sm" disabled={disabled} aria-label="Who runs the jobs" className="max-w-64 min-w-0">
      {driver.kind === "pair" ? (
        pair ? (
          <PairChipInner pair={pair} />
        ) : (
          <>
            <Network className="text-violet" />
            <span className="truncate">{pairsQ.isPending ? "Pair" : "Pair missing"}</span>
          </>
        )
      ) : (
        <>
          {agent.engine || agent.model ? <ModelIcon model={agent.model} engine={agent.engine} className="size-3.5" /> : <Bot />}
          <span className="truncate font-mono text-xs">{[agent.model || agent.engine || "Default agent", agent.agent].filter(Boolean).join(" · ")}</span>
        </>
      )}
      <ChevronDown className="text-fg-faint" />
    </Button>
  );

  return (
    <Popover trigger={chip} align="end" width={344}>
      <RunTabs tab={tab} setTab={setTab} hasPair={driver.kind === "pair"}>
        {tab === "harness" ? (
          <div className="flex flex-col gap-3 p-2">
            <WhoPicker who={{ engine: agent.engine || undefined, model: agent.model || undefined }} onChange={(w) => onChange({ ...agent, engine: w.engine ?? null, model: w.model ?? null })} />
            <Field label="Agent">
              <Select size="sm" aria-label="Agent" value={agent.agent ?? ""} onChange={(v) => onChange({ ...agent, agent: v || null })} options={[{ value: "", label: "No agent", hint: "plain session" }, ...(agents.data ?? []).map((a) => ({ value: a.name, label: a.title }))]} placeholder="No agent" />
            </Field>
          </div>
        ) : (
          <>
            <PairList
              pairs={pairsQ.data ?? []}
              selectedId={driver.kind === "pair" ? driver.pairId : ""}
              refetch={pairsQ.refetch}
              onPick={(id) => {
                if (id) onChange({ kind: "pair", pairId: id });
                else {
                  setTab("harness");
                  onChange(agentFromWho(getWho()));
                }
              }}
            />
            <p className="px-2 pt-2 text-label text-fg-muted">Map, Plan and Fix are led by the pair. Test runs as one session on the lead&apos;s engine.</p>
          </>
        )}
      </RunTabs>
    </Popover>
  );
}
