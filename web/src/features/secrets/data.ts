import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { del, get, post, put, qs } from "@/lib/api";

export interface SecretEnv {
  name: string;
  url: string | null;
  builtin: boolean;
  secrets: number;
}

/** A secret's name and when it was set. The value never reaches the browser. */
export interface SecretKey {
  key: string;
  updatedAt: string;
}

const envsKey = (ws: string) => ["secret-envs", ws] as const;
const keysKey = (ws: string, env: string) => ["secret-keys", ws, env] as const;

export function useSecretEnvs(ws: string) {
  return useQuery({
    queryKey: envsKey(ws),
    queryFn: async () => (await get<{ envs: SecretEnv[] }>(`/api/workspaces/${ws}/envs`)).envs,
  });
}

export function useSecretKeys(ws: string, env: string) {
  return useQuery({
    queryKey: keysKey(ws, env),
    queryFn: async () => (await get<{ keys: SecretKey[] }>(`/api/workspaces/${ws}/secrets${qs({ env })}`)).keys,
  });
}

/** Every mutation here refreshes the environment list (its counts) and the key list of the environment it touched. */
export function useSecretActions(ws: string) {
  const qc = useQueryClient();
  const refresh = (env?: string) => {
    void qc.invalidateQueries({ queryKey: envsKey(ws) });
    if (env) void qc.invalidateQueries({ queryKey: keysKey(ws, env) });
  };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "That did not work.");

  const setSecret = useMutation({
    mutationFn: (v: { env: string; key: string; value: string }) => put(`/api/workspaces/${ws}/secrets/${encodeURIComponent(v.key)}${qs({ env: v.env })}`, { value: v.value }),
    onSuccess: (_d, v) => {
      refresh(v.env);
      toast.success(`${v.key} saved`);
    },
    onError: fail,
  });

  const unsetSecret = useMutation({
    mutationFn: (v: { env: string; key: string }) => del(`/api/workspaces/${ws}/secrets/${encodeURIComponent(v.key)}${qs({ env: v.env })}`),
    onSuccess: (_d, v) => {
      refresh(v.env);
      toast.success(`${v.key} removed`);
    },
    onError: fail,
  });

  const addEnv = useMutation({
    mutationFn: (v: { name: string }) => post(`/api/workspaces/${ws}/envs`, { name: v.name }),
    onSuccess: () => refresh(),
    onError: fail,
  });

  const removeEnv = useMutation({
    mutationFn: (v: { name: string }) => del(`/api/workspaces/${ws}/envs/${encodeURIComponent(v.name)}`),
    onSuccess: (_d, v) => {
      refresh(v.name);
      toast.success(`${v.name} removed`);
    },
    onError: fail,
  });

  return { setSecret, unsetSecret, addEnv, removeEnv };
}
