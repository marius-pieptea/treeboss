import { ChecklistsEditor } from "@/features/checklists/ChecklistsEditor";
import { PageShell } from "./shared";

/** Settings → Checklists: the launch checklists every project starts from. The editor is shared with the checklist panel. */
export function ChecklistsPage() {
  return (
    <PageShell wide title="Checklists" description="What a project must show before a prod deploy: the launch checklists. The built-in ones are yours to edit, fork or reset. A project can also disable an item or add its own, from its Checklists panel.">
      <ChecklistsEditor />
    </PageShell>
  );
}
