import { useEffect } from "react";
import { navigate } from "@/lib/nav";

export function Navigate({ to }: { to: string }) {
  useEffect(() => navigate(to, true), [to]);
  return null;
}
