/**
 * What a head's conversation shows. The stored first prompt of a head is the harness's long wrapper (rules, workspace
 * note, role text) around the brief; the person wants to see the brief, and follow-ups without their header.
 */
import type { TranscriptItem } from "@/lib/transcript";

const FOLLOW_UP = /^# Follow-up from [^\n]*\n+/gm;

/** The message a person actually sent, out of the harness's wrapper text. */
export function cleanPrompt(text: string): string {
  let last = -1;
  let len = 0;
  for (const m of text.matchAll(FOLLOW_UP)) {
    last = m.index ?? -1;
    len = m[0].length;
  }
  if (last !== -1) return text.slice(last + len).trim();
  return text.trim();
}

export function conversationItems(items: TranscriptItem[], o: { session: string; brief: string | null; depth: number }): TranscriptItem[] {
  const mine = items.filter((i) => i.session === o.session);
  if (o.depth === 0 || !o.brief) return mine.map((i) => (i.type === "user" ? { ...i, text: cleanPrompt(i.text) } : i));
  let droppedFirst = false;
  const out: TranscriptItem[] = [];
  for (const it of mine) {
    if (it.type === "user") {
      // The first prompt is the wrapper around the brief: replace it with the brief itself.
      if (!droppedFirst) {
        droppedFirst = true;
        out.push({ ...it, text: o.brief });
      } else out.push({ ...it, text: cleanPrompt(it.text) });
    } else out.push(it);
  }
  // Log lines can arrive before the turns list does: still lead with the brief.
  if (!droppedFirst) out.unshift({ type: "user", id: "brief", session: o.session, turnId: "brief", text: o.brief });
  return out;
}
