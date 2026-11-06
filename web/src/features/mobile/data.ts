import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, post } from "@/lib/api";
import { openEmulator } from "../emulator/open";
import { runExpoOnEmulator } from "../emulator/emulator-api";

export type MobilePlatform = "ios" | "android";

export interface MobileBuild {
  id: string;
  platform: MobilePlatform;
  profile: string;
  easBuildId: string | null;
  /** EAS status, lower-cased: new, in_queue, in_progress, finished, errored, canceled. */
  status: string;
  artifactUrl: string | null;
  version: string | null;
  buildNumber: string | null;
  createdAt: string;
}

export interface MobileSubmission {
  id: string;
  platform: MobilePlatform;
  profile: string;
  status: "submitted" | "failed";
  detail: string | null;
  createdAt: string;
}

export interface MobileIssue {
  field: string;
  problem: string;
}

export interface MobileState {
  detect: {
    isExpo: boolean;
    name: string | null;
    sdkVersion: string | null;
    platforms: MobilePlatform[];
    bundleId: string | null;
    androidPackage: string | null;
    profiles: string[];
    submitProfiles: string[];
    notes: string[];
  };
  metadata: { path: string; present: boolean; issues: MobileIssue[] };
  builds: MobileBuild[];
  submissions: MobileSubmission[];
}

export interface MobilePreview {
  url: string;
  svg: string;
  started: boolean;
}

const mobileKey = (root: string) => ["mobile", root] as const;

export const useMobile = (root: string) =>
  useQuery({
    queryKey: mobileKey(root),
    queryFn: () => get<MobileState>(`/api/mobile/${root}`),
    // Builds move on their own: the panel re-reads the list while one is in flight.
    refetchInterval: (q) => (q.state.data?.builds.some((b) => ["new", "in_queue", "in_progress"].includes(b.status)) ? 15_000 : false),
  });

/** The Expo Go tunnel. Fetched only when asked: starting the tunnel takes a while and is not free. */
export const usePreview = (root: string, enabled: boolean) =>
  useQuery({
    queryKey: ["mobile", root, "preview"],
    queryFn: () => get<MobilePreview>(`/api/mobile/${root}/preview`),
    enabled,
    retry: false,
    staleTime: Infinity,
  });

export function useMobileActions(root: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: mobileKey(root) });
  const onError = (e: Error) => toast.error(e.message);

  const build = useMutation({
    mutationFn: (input: { platform: MobilePlatform | "all"; profile: string }) => post<{ builds: MobileBuild[] }>(`/api/mobile/${root}/builds`, input),
    onSuccess: () => {
      toast.success("Build queued on EAS");
      refresh();
    },
    onError,
  });

  const submit = useMutation({
    mutationFn: (input: { platform: MobilePlatform; profile: string }) => post(`/api/mobile/${root}/submit`, input),
    onSuccess: () => {
      toast.success("Submitted the latest build");
      refresh();
    },
    onError: (e: Error) => {
      toast.error(e.message);
      refresh();
    },
  });

  const update = useMutation({
    mutationFn: (input: { branch: string; message: string }) => post(`/api/mobile/${root}/update`, input),
    onSuccess: () => toast.success("Update published"),
    onError,
  });

  /** Start the app's Metro on the emulator, and open the emulator to watch it. */
  const runOnEmulator = useMutation({
    mutationFn: async () => {
      const r = await runExpoOnEmulator(root);
      if (!r.ok) throw new Error(r.error);
    },
    onSuccess: openEmulator,
    onError,
  });

  return { build, submit, update, runOnEmulator };
}
