/**
 * Design work from the composer: the `/design` command, the intent a Design chip carries, and the hand-off
 * from other views (the Design tab, the palette). The daemon turns the message into the design prompt (see
 * src/daemon/routes/design.ts); here we only decide which kind of design turn the operator asked for.
 */
import { bus } from "@/lib/bus";
import { useUi } from "@/lib/store";
import { BRAINSTORM_KINDS, inputFor, inputProblem, type DesignKind } from "./logic";

export interface DesignIntent {
  kind: DesignKind;
  /** brief and url only: questions and directions first. */
  brainstorm: boolean;
}

export interface DesignCommand {
  intent: DesignIntent;
  input: string;
  /** False: `/design` alone (or a kind that needs text, without it): set the chip and let the operator type. */
  send: boolean;
}

const WORDS: Record<string, DesignKind> = { brief: "brief", url: "url", ref: "url", reference: "url", code: "codebase", codebase: "codebase", wire: "wire", review: "review" };

/**
 * `/design …` as typed. Unlike other slash commands it may span lines (a brief often does).
 *   /design                      the chip, for a brief
 *   /design <brief text>         a brief
 *   /design https://…            a reference site
 *   /design code|wire|review [notes]
 *   /design --quick …            no brainstorm (brief and url)
 */
export function parseDesignCommand(text: string): DesignCommand | null {
  const m = /^\/design(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  let rest = (m[1] ?? "").trim();
  let brainstorm = true;
  const flag = /^--(quick|no-brainstorm)\b\s*/i.exec(rest);
  if (flag) {
    brainstorm = false;
    rest = rest.slice(flag[0].length);
  }
  const first = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  const word = first ? WORDS[first[1]!.toLowerCase()] : undefined;
  let kind: DesignKind = "brief";
  let input = rest;
  if (word) {
    kind = word;
    input = first![2]!.trim();
  } else if (/^https?:\/\/\S+$/i.test(rest)) kind = "url";
  const intent = { kind, brainstorm: brainstorm && BRAINSTORM_KINDS.includes(kind) };
  return { intent, input, send: !needsText(kind) || !!input };
}

/** Whether a kind cannot be sent without text of the operator's. */
export const needsText = (kind: DesignKind): boolean => inputFor(kind).required;

/** Why this message cannot go as this kind of design turn, or null. */
export const designProblem = (intent: DesignIntent, input: string): string | null => inputProblem(intent.kind, input);

export const INTENT_LABEL: Record<DesignKind, string> = { brief: "Design system", url: "Design from a site", codebase: "Design from the code", wire: "Wire tokens", review: "Design review" };

export function intentLabel(i: DesignIntent): string {
  return `${INTENT_LABEL[i.kind]}${BRAINSTORM_KINDS.includes(i.kind) ? (i.brainstorm ? " · brainstorm" : " · one go") : ""}`;
}

export const placeholderFor = (kind: DesignKind): string => inputFor(kind).placeholder;

/* -------------------------------------------------------------------------- */
/* Hand-off from other views                                                  */
/* -------------------------------------------------------------------------- */

let pending: DesignIntent | null = null;

/** Called by the composer when it mounts or hears the event: the intent waiting for it, once. */
export function takePendingDesign(): DesignIntent | null {
  const p = pending;
  pending = null;
  return p;
}

/**
 * Put a design intent on the composer of a fresh session and focus it. The composer may not be mounted yet
 * (the right panel was closed): it picks the intent up when it mounts.
 */
export function composeDesign(kind: DesignKind, o: { brainstorm?: boolean } = {}): void {
  pending = { kind, brainstorm: o.brainstorm !== false && BRAINSTORM_KINDS.includes(kind) };
  const ui = useUi.getState();
  ui.setActiveSession(null);
  ui.setRightTab("agent");
  setTimeout(() => bus.emit("composer-design"), 40);
}
