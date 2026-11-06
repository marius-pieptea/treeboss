import { useEffect, useState } from "react";
import { ListChecks } from "lucide-react";
import { ChecklistPanel, type ChecklistFocus } from "@/features/checklists/ChecklistPanel";
import { bus } from "@/lib/bus";
import { LabPage } from "./shared";
import { takePendingChecklists } from "./views";

/** The launch checklists of the project, on the checklist and item an intent asked for. */
export function ChecklistsTab() {
  const [focus, setFocus] = useState<ChecklistFocus | null>(null);

  useEffect(() => {
    const take = () => {
      const i = takePendingChecklists();
      if (i?.checklist) setFocus({ checklist: i.checklist, item: i.item ?? null });
    };
    take();
    return bus.on("checklists-open", take);
  }, []);

  return (
    <LabPage icon={<ListChecks />} title="Checklists" hint="What the project needs before it launches, checked by agents and by you.">
      <section className="rounded-xl border border-line bg-panel" aria-label="Checklists">
        <ChecklistPanel focus={focus} />
      </section>
    </LabPage>
  );
}
