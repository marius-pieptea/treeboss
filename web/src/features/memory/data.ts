import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, patch, post } from "@/lib/api";

export interface MemoryRule {
  id: string;
  text: string;
}
export interface MemoryFile {
  path: string;
  exists: boolean;
  managed: boolean;
  note: string | null;
}
export interface MemoryView {
  rules: MemoryRule[];
  files: MemoryFile[];
}

export const memKey = (root: string) => ["memory", root] as const;

export function useMemory(root: string) {
  return useQuery({ queryKey: memKey(root), queryFn: () => get<{ memory: MemoryView }>(`/api/memory/${root}`).then((r) => r.memory), retry: false });
}

export function useMemoryActions(root: string) {
  const qc = useQueryClient();
  const done = (r: { memory: MemoryView }) => qc.setQueryData(memKey(root), r.memory);
  const onError = (e: Error) => toast.error(e.message);
  return {
    add: useMutation({ mutationFn: (text: string) => post<{ memory: MemoryView }>(`/api/memory/${root}/rules`, { text }), onSuccess: done, onError }),
    edit: useMutation({ mutationFn: (a: { id: string; text: string }) => patch<{ memory: MemoryView }>(`/api/memory/${root}/rules/${a.id}`, { text: a.text }), onSuccess: done, onError }),
    remove: useMutation({ mutationFn: (id: string) => del<{ memory: MemoryView }>(`/api/memory/${root}/rules/${id}`), onSuccess: done, onError }),
  };
}

/** Ask the daemon whether a message you just sent reads as a standing convention. Errors are swallowed: this is a nicety. */
export async function suggestRule(root: string, message: string): Promise<string | null> {
  try {
    const r = await post<{ proposal: { text: string } | null }>(`/api/memory/${root}/suggest`, { message });
    return r.proposal?.text ?? null;
  } catch {
    return null;
  }
}
