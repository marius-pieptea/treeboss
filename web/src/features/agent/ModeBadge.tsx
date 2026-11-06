import { ClipboardList, MessageCircleQuestion } from "lucide-react";
import { Badge } from "@/components/ui/misc";

/** "ask" / "plan" beside a session's title: the sessions list and the header show the read-only modes. */
export function ModeBadge({ mode }: { mode: "ask" | "plan" }) {
  return mode === "ask" ? (
    <Badge tone="accent" title="Ask mode: read-only questions, nothing is written">
      <MessageCircleQuestion className="size-2.5 shrink-0" />
      ask
    </Badge>
  ) : (
    <Badge tone="violet" title="Plan mode: read-only until a plan is approved">
      <ClipboardList className="size-2.5 shrink-0" />
      plan
    </Badge>
  );
}
