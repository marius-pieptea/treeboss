import { useCallback, useEffect, useState } from "react";
import { bus } from "@/lib/bus";
import { useWorkspace } from "@/lib/workspace";
import { QaBoardView } from "./QaBoardView";
import { takeQaIntent, type QaIntent } from "./open";

export function QaTab() {
  const { root } = useWorkspace();
  const [intent, setIntent] = useState<QaIntent | null>(null);
  useEffect(() => {
    const take = () => {
      const i = takeQaIntent();
      if (i) setIntent(i);
    };
    take();
    return bus.on("qa-open", take);
  }, []);
  const done = useCallback(() => setIntent(null), []);
  return <QaBoardView root={root} intent={intent} onIntentDone={done} />;
}
