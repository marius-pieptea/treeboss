/**
 * The URLs a checklist pass can run against: the running dev servers of a folder, and the deploy targets of its workspace
 * that have a URL. One list for `/checklists/urls` (the Run menu) and for the fix prompt (plan.ts).
 */
import fs from "fs";
import { listTargets } from "../deploy/store";
import { listInstances } from "../devserver/manager";
import { SCREEN_ITEMS } from "./screens";

export interface CheckUrl {
  label: string;
  url: string;
  kind: "dev" | "deploy";
}

export function checkUrls(workspaceId: string, folder: string): CheckUrl[] {
  let root = folder;
  try {
    root = fs.realpathSync(folder);
  } catch {}
  const urls: CheckUrl[] = [];
  for (const i of listInstances(root)) {
    if (i.kind !== "dev" || i.status !== "running") continue;
    const url = i.url ?? (i.port ? `http://localhost:${i.port}` : null);
    if (url) urls.push({ label: `Dev server · ${i.service}`, url, kind: "dev" });
  }
  for (const t of listTargets(workspaceId)) if (t.url) urls.push({ label: `${t.env} · deploy`, url: t.url, kind: "deploy" });
  return urls;
}

/** The agent items that judge a rendered sales page (screenshots, visible copy), so they need a served URL. */
export const SALES_PAGE_ITEMS: ReadonlySet<string> = new Set([
  ...Object.keys(SCREEN_ITEMS),
  "cta-one-primary",
  "pricing-highlight",
  "landing-nav",
  "value-prop-hero",
  "brand-voice",
  "proof-backs-claims",
  "target-keyword",
]);
