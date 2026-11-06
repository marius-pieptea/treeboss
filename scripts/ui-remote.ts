/**
 * The remote modes and the compact remote view end to end, with nothing bound beyond loopback. A fake `tailscale`
 * on PATH reports a tailnet name; the daemon is told not to open its second listener (TRB_REMOTE_NO_LISTEN), and
 * Chrome resolves that name to 127.0.0.1, so the phone really arrives with a non-loopback Host header.
 *
 * Flow: pick a mode in Settings > Remote access (LAN warning, then Tailscale), pair a phone-sized browser through the
 * real /_pair page from the link the UI shows, answer a plan question, approve the plan, send a follow-up, switch the
 * mode (the phone is refused on the old name), then revoke. Shots in /tmp/trb-shots/remote-*.png.
 * Needs Chrome. `bun run build:web && TRB_WEB_DIR=web/dist bun run scripts/ui-remote.ts`
 */
import fs from "fs";
import os from "os";
import path from "path";
import { withUi } from "./ui-harness";

let failed = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};
fs.mkdirSync("/tmp/trb-shots", { recursive: true });

const ASK = JSON.stringify({ question: "Where should the cache live?", options: [{ label: "SQLite", description: "One file next to the daemon database.", recommended: true }, { label: "In memory" }] });
const PLAN = JSON.stringify({ title: "Add a model cache", summary: "Keep the catalog in SQLite.", steps: [{ title: "Create the cache table", detail: "One row per engine." }, { title: "Read through the cache", detail: "Serve fresh rows." }], risks: [] });

const NAME = "demo-mac.tail1234.ts.net";
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "trb-fake-tailscale-"));
fs.writeFileSync(
  path.join(fakeBin, "tailscale"),
  `#!/bin/sh
case "$1" in
  ip) echo 100.101.102.103 ;;
  status) echo '{"BackendState":"Running","Self":{"DNSName":"${NAME}.","TailscaleIPs":["100.101.102.103"]}}' ;;
esac
`,
  { mode: 0o755 },
);
const env = {
  PATH: `${fakeBin}:${process.env.PATH}`,
  TRB_REMOTE_NO_LISTEN: "1",
  TRB_REMOTE_INTERFACES: JSON.stringify({ en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }], docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }] }),
};

await withUi(
  async ({ browser, trb, repo, shot, page, url, workspaceId }) => {
    trb("config", "set", "default_engine", "fake");
    check("pairing is refused while remote access is off", trb("remote", "pair").code !== 0);

    // Settings > Remote access on the desktop.
    await page.goto(`${url}/w/${workspaceId}`);
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: /Remote access/i }).click();
    await page.waitForSelector("[role=radiogroup]");
    check("three modes are offered", (await page.locator("[role=radio]").count()) === 3);
    check("off is selected and nothing can be paired", (await page.locator("[data-mode=off][aria-checked=true]").count()) === 1 && (await page.getByRole("button", { name: "Pair a phone", exact: true }).isDisabled()));
    await shot("remote-0-modes-off");

    // LAN: a warning first; cancelling leaves it off.
    await page.locator("[data-mode=lan]").click();
    await page.waitForSelector("text=Anyone on the same Wi-Fi or Ethernet can see the traffic");
    check("choosing LAN warns that it is plain http visible to the network", true);
    await shot("remote-1-lan-warning");
    await page.getByRole("button", { name: /Cancel/i }).click();
    await page.waitForTimeout(300);
    check("cancelling keeps remote access off", JSON.parse(trb("remote", "status", "--json").stdout).mode === "off");

    // Tailscale, found through the fake CLI.
    await page.locator("[data-mode=tailscale]").click();
    await page.waitForSelector("[data-mode=tailscale][aria-checked=true]");
    await page.waitForSelector("[data-testid=remote-status]");
    const statusText = await page.locator("[data-testid=remote-status]").innerText();
    check("status shows the MagicDNS link, not localhost", statusText.includes(`http://${NAME}:`) && !statusText.includes("127.0.0.1"), statusText.replace(/\n/g, " | "));
    await shot("remote-2-tailscale");
    await page.getByRole("button", { name: "Pair a phone", exact: true }).click();
    await page.waitForSelector("[data-testid=pair-url]");
    const link = (await page.locator("[data-testid=pair-url]").innerText()).trim();
    check("the QR is shown with its link as text, on the tailnet name", (await page.locator("img[alt='QR code to pair a phone']").count()) === 1 && link.startsWith(`http://${NAME}:`) && /_pair\?code=/.test(link), link.slice(0, 60));
    await shot("remote-3-pair-qr");
    const pair = { url: link };

    // A plan-mode session that asks a question and then submits a plan.
    trb("run", "-e", "fake", "--plan", "-d", "-C", repo, `CALL_TOOL plan_ask ${ASK}\nCALL_TOOL plan_submit ${PLAN}`);

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await phone.newPage();
    p.on("pageerror", (e) => console.error("[phone pageerror]", e.message));
    p.on("console", (m) => m.type() === "error" && console.error("[phone console.error]", m.text().slice(0, 200)));

    // The pairing link only shows a confirm button; nothing is spent until it is pressed.
    await p.goto(pair.url);
    check("the link shows a confirm page, not the app", (await p.locator("button", { hasText: "Pair this device" }).count()) === 1);
    await p.screenshot({ path: "/tmp/trb-shots/remote-pair.png" });
    await p.locator("button", { hasText: "Pair this device" }).click();
    await p.waitForURL(/\/remote/);
    await p.waitForSelector("text=Sessions");
    check("paired: the compact session list is shown", (await p.locator("main button").count()) >= 1);
    check("the device cannot see the full IDE", (await p.locator("[data-status-slot]").count()) === 0);
    await p.waitForSelector("text=Needs your answer", { timeout: 30_000 });
    await p.screenshot({ path: "/tmp/trb-shots/remote-list.png" });

    const reuse = await (await fetch(`http://127.0.0.1:${new URL(pair.url).port}/_pair${new URL(pair.url).search}`, { headers: { host: new URL(pair.url).host } })).text();
    check("the same code cannot be used again", reuse.includes("expired"));

    await p.locator("main button").first().click();
    await p.waitForSelector("text=Where should the cache live?", { timeout: 20_000 });
    await p.screenshot({ path: "/tmp/trb-shots/remote-question.png" });
    await p.locator("button", { hasText: "SQLite" }).click();
    await p.locator("button", { hasText: "Send answer" }).click();
    await p.waitForSelector("text=Add a model cache", { timeout: 25_000 });
    await p.waitForSelector("button:has-text('Approve and build'):not([disabled])", { timeout: 20_000 });
    await p.screenshot({ path: "/tmp/trb-shots/remote-plan.png" });
    await p.locator("button", { hasText: "Approve and build" }).click();
    await p.waitForSelector("text=Approve and build", { state: "detached", timeout: 20_000 });
    check("approving from the phone leaves plan mode", true);

    await p.waitForSelector("textarea[placeholder='Send a follow-up']", { timeout: 20_000 });
    await p.locator("textarea").fill("SAY hello from the phone");
    await p.locator("button[aria-label=Send]").click();
    await p.waitForSelector("text=hello from the phone", { timeout: 20_000 });
    await p.screenshot({ path: "/tmp/trb-shots/remote-followup.png" });
    check("a follow-up from the phone runs", true);

    // The phone cannot reach the IDE's API even by hand.
    const denied = await p.evaluate(async () => (await fetch("/api/config")).status);
    const term = await p.evaluate(async () => (await fetch("/api/terminals", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
    check("config and terminals are refused for the device", denied === 403 && term === 403, `${denied}/${term}`);

    // The device list on the desktop shows it.
    await page.waitForSelector("text=Paired devices");
    await page.getByRole("button", { name: "Done" }).click();
    await page.waitForSelector("button:has-text('Revoke')", { timeout: 10_000 });
    await shot("remote-4-devices");

    // Switching the mode ends the old name's access; switching back lets the same device in again.
    trb("config", "set", "remote_mode", "lan");
    await p.waitForTimeout(500);
    const wrongHost = await p.evaluate(async () => (await fetch("/api/sessions")).status);
    check("after switching to LAN the tailnet name is refused", wrongHost === 403, String(wrongHost));
    trb("config", "set", "remote_mode", "tailscale");
    await p.waitForTimeout(300);
    const back = await p.evaluate(async () => (await fetch("/api/sessions")).status);
    check("switching back lets the paired device in again", back === 200, String(back));

    // The owner revokes it: the phone is told on its next call.
    const id = JSON.parse(trb("remote", "ls", "--json").stdout).tokens[0].id;
    check("the device is listed", !!id);
    trb("remote", "revoke", id);
    const after = await p.evaluate(async () => (await fetch("/api/sessions")).status);
    check("after revoking, the device is refused", after === 401, String(after));
    await p.reload();
    await p.waitForSelector("text=This device is not paired", { timeout: 15_000 });
    await p.screenshot({ path: "/tmp/trb-shots/remote-revoked.png" });
    await phone.close();

    trb("config", "set", "remote_mode", "off");
    check("off: pairing is refused again", trb("remote", "pair").code !== 0);
    await page.close();
  },
  { env, chromeArgs: [`--host-resolver-rules=MAP ${NAME} 127.0.0.1`] },
);
fs.rmSync(fakeBin, { recursive: true, force: true });

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
