/** Ask mode's data: the cheap model a new ask session starts on, a turn's cost, and the two follow-ups' calls. */
import { useQuery } from "@tanstack/react-query";
import { get, post, qs } from "@/lib/api";
import type { TurnRow } from "@/lib/types";

export interface AskDefault {
  model: string | null;
  effort: string;
}

/** What a NEW ask session on `engine` would start on (the daemon's `ask_models` map, else its built-in cheap default). */
export const useAskDefault = (engine: string, enabled: boolean) =>
  useQuery({
    queryKey: ["ask", "model", engine],
    enabled: enabled && !!engine,
    staleTime: 60_000,
    queryFn: () => get<AskDefault>(`/api/ask/model${qs({ engine })}`),
  });

/** A session's turns (mode, cost and usage per turn): what the ask answer footer reads. Refetched when a turn ends. */
export const useSessionTurns = (sessionId: string | null, version: number | string) =>
  useQuery({
    queryKey: ["turns", sessionId, version],
    enabled: !!sessionId,
    staleTime: 5_000,
    queryFn: () => get<{ turns: TurnRow[] }>(`/api/sessions/${sessionId}/turns`).then((r) => r.turns),
  });

export interface AskDocPreview {
  turnId: string;
  path: string;
  title: string;
  question: string;
  covers: string[];
  content: string;
}

export const fetchAskDoc = (sessionId: string, turnId: string) => get<{ preview: AskDocPreview }>(`/api/sessions/${sessionId}/ask/doc${qs({ turn: turnId })}`).then((r) => r.preview);
export const saveAskDoc = (sessionId: string, body: { turn: string; path: string }) => post<{ page: { path: string; title: string } }>(`/api/sessions/${sessionId}/ask/doc`, body).then((r) => r.page);
