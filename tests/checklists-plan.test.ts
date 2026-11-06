/** The fix prompt names the served URLs for the sales-page judgement items. */
import { beforeEach, describe, expect, test } from "bun:test";
import { attach } from "../src/checklists/store";
import { checklistPass, passChunks } from "../src/checklists/plan";
import { checkUrls } from "../src/checklists/urls";
import { createTarget } from "../src/deploy/store";
import { Workspaces } from "../src/workspaces";
import { makeRepo, resetState } from "./helpers";

beforeEach(resetState);

const prompts = (dir: string, list: string, fix: boolean) => passChunks(dir, [list], fix).map((t) => checklistPass(dir, t, { fix }).prompt).join("\n");

describe("served URLs in the fix prompt", () => {
  test("a fix pass over the sales-page items lists the workspace's deploy URLs", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    createTarget({ workspaceId: id, env: "prod", provider: "command", config: { argv: ["true"] }, url: "https://shop.example.com" });
    expect(checkUrls(id, dir)).toEqual([{ label: "prod · deploy", url: "https://shop.example.com", kind: "deploy" }]);
    const fix = prompts(dir, "marketing-site", true);
    expect(fix).toContain("(cta-above-fold)");
    expect(fix).toContain("Served URLs");
    expect(fix).toContain("prod · deploy: https://shop.example.com");
  });

  test("an audit pass, and a workspace with no URL, get no URL block", () => {
    const dir = makeRepo({ "package.json": "{}\n" });
    const id = Workspaces.open(dir).id;
    attach(id, "marketing-site");
    expect(prompts(dir, "marketing-site", true)).not.toContain("Served URLs");
    createTarget({ workspaceId: id, env: "prod", provider: "command", config: { argv: ["true"] }, url: "https://shop.example.com" });
    expect(prompts(dir, "marketing-site", false)).not.toContain("Served URLs");
  });
});
