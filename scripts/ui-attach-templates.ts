/**
 * Attach any file in the composer (a PDF and an HTML page through the file picker, a zip by drop), send,
 * and edit a template in Settings, then see it in New app. Real daemon (scripted engine), throwaway home.
 *
 *   bun run build:web && bun run scripts/ui-attach-templates.ts
 */
import fs from "fs";
import os from "os";
import path from "path";
import { withUi } from "./ui-harness";
import { makePdf, makeZip } from "../tests/attach-fixtures";

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
};

fs.mkdirSync("/tmp/trb-shots", { recursive: true });
const fx = fs.mkdtempSync(path.join(os.tmpdir(), "trb-attach-fx-"));
const pdf = path.join(fx, "report.pdf");
const html = path.join(fx, "pricing.html");
fs.writeFileSync(pdf, makePdf("Quarterly revenue grew"));
fs.writeFileSync(html, "<html><title>Pricing</title><body><h1>Plans</h1><p>Starter costs nine dollars</p></body></html>");
const zip = makeZip([
  { name: "site/README.md", data: "# Site\nbuilt with love" },
  { name: "site/src/app.ts", data: "export const app = 1;" },
  { name: "../escape.txt", data: "nope" },
]);

await withUi(async ({ page, shot, home, trb, workspaceId, url, repo }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A scripted-engine session to follow up in (never a real model).
  trb("run", "-e", "fake", "-d", "-C", repo, "Attach files demo\nSAY ready");
  for (let i = 0; i < 60 && /running/.test(trb("ls").stdout); i++) await Bun.sleep(150);
  await page.goto(`${url}/w/${workspaceId}`);
  await page.locator("button", { hasText: "Attach files demo" }).first().click();
  await page.waitForSelector('textarea[aria-label="Message"]');

  // ---- pick two files from the + menu
  await page.locator("[data-plus-menu]").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-attach-files]").click();
  await (await chooser).setFiles([pdf, html]);
  await page.waitForSelector('[data-context-chip="upload"]', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-context-chip="upload"]').length === 2, null, { timeout: 10_000 });
  // ---- drop a zip
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "site.zip", { type: "application/zip" }));
    const el = document.querySelector("[data-composer]")!;
    el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, zip.toString("base64"));
  await page.waitForFunction(() => document.querySelectorAll('[data-context-chip="upload"]').length === 3, null, { timeout: 10_000 });
  const chips = await page.locator('[data-context-chip="upload"]').allInnerTexts();
  check("three chips with name and size", chips.length === 3 && chips.some((c) => /report\.pdf/.test(c) && /\d+(\.\d)? (B|KB)/.test(c)) && chips.some((c) => /pricing\.html/.test(c)) && chips.some((c) => /site\.zip/.test(c)), chips.join(" | "));
  await shot("attach-1-chips");

  // ---- remove one, then it can be added back by the picker
  await page.getByLabel("Remove pricing.html").click();
  check("a chip can be removed", (await page.locator('[data-context-chip="upload"]').count()) === 2);
  await page.locator("[data-plus-menu]").click();
  const chooser2 = page.waitForEvent("filechooser");
  await page.locator("[data-attach-files]").click();
  await (await chooser2).setFiles([html]);
  await page.waitForFunction(() => document.querySelectorAll('[data-context-chip="upload"]').length === 3, null, { timeout: 10_000 });

  // ---- send: the engine reports what it received
  await page.locator('textarea[aria-label="Message"]').fill("ECHO_PROMPT Quarterly revenue grew\nECHO_PROMPT Starter costs nine dollars\nECHO_PROMPT site/src/app.ts\nECHO_PROMPT Unpacked into\nSAY done reading");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /prompt-has\[Unpacked into\]/.test(document.body.innerText), null, { timeout: 30_000 }).catch(async () => {
    await shot("attach-2-timeout");
  });
  const body = await page.locator("body").innerText();
  check("the engine received the PDF's text, the HTML text, the zip's tree and its unpacked path", ["Quarterly revenue grew", "Starter costs nine dollars", "site/src/app.ts", "Unpacked into"].every((n) => body.includes(`prompt-has[${n}]=yes`)), body.match(/prompt-has\[[^\n]*/g)?.join(" ; "));
  await shot("attach-2-sent");
  const sid = trb("ls", "--json").stdout.match(/"id":\s*"([^"]+)"/)?.[1] ?? "";
  const shown = trb("logs", sid).stdout + trb("show", sid).stdout;
  void shown;

  // What the engine was handed, straight from the stored files.
  const store = path.join(home, "context-files");
  const dirs = fs.readdirSync(store);
  check("stored under the trb home (one re-added after removal)", dirs.length === 4, dirs.join(","));
  const unpacked = dirs.map((d) => path.join(store, d, "unpacked")).find((d) => fs.existsSync(d));
  check("the zip was unpacked under the home, safely", !!unpacked && fs.existsSync(path.join(unpacked, "site/src/app.ts")) && !fs.existsSync(path.join(store, "escape.txt")) && !fs.existsSync(path.join(path.dirname(path.dirname(unpacked)), "escape.txt")), unpacked);
  const extracted = dirs.map((d) => path.join(store, d, "extracted.txt")).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf-8"));
  check("extracted text saved for the PDF and the HTML page", extracted.some((t) => /Quarterly revenue grew/.test(t)) && extracted.some((t) => /Starter costs nine dollars/.test(t)));
  void repo;

  // ---- Settings > Templates: edit and save
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Templates: edit");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-template-editor]", { timeout: 10_000 });
  const items = await page.locator("[data-template-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-template-item")));
  check("the four built-ins are listed as ordinary entries", JSON.stringify(items) === JSON.stringify(["nextjs", "hono-api", "vite-react", "expo"]), items.join(","));
  await shot("templates-1-list");
  await page.locator('[data-template-item="vite-react"] button').first().click();
  await page.locator("[data-template-name]").fill("Vite React (mine)");
  await page.locator("[data-template-generate]").fill("bunx create-vite@latest . --template react-swc-ts");
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Step 2", { exact: true }).fill("bun run build");
  check("the argv preview shows each argument", (await page.getByLabel("Arguments as they will be passed").first().locator("span").count()) === 5);
  await shot("templates-2-editing");
  await page.locator("[data-template-save]").click();
  await page.waitForFunction(() => /Vite React \(mine\)/.test(document.querySelector('[data-template-item="vite-react"]')?.textContent ?? ""), null, { timeout: 10_000 });
  const token = fs.readFileSync(path.join(home, "token"), "utf-8").trim();
  const saved: any = await (await fetch(`${url}/api/scaffold/recipes`, { headers: { authorization: `Bearer ${token}` } })).json();
  const vite = saved.recipes.find((r: any) => r.id === "vite-react");
  check("the edit is stored", vite.name === "Vite React (mine)" && vite.generate.join(" ").includes("react-swc-ts") && vite.steps.length === 2 && vite.modified === true, JSON.stringify(vite.steps));
  check("it is written to recipes.json in the home", JSON.parse(fs.readFileSync(path.join(home, "recipes.json"), "utf-8")).recipes.some((r: any) => r.name === "Vite React (mine)"));

  // a shell operator is refused with a message
  await page.locator("[data-template-generate]").fill("bun install && bun x");
  await page.locator("[data-template-save]").click();
  await page.getByText(/shell operator/).first().waitFor({ timeout: 8000 });
  check("a command that relies on a shell is refused on save", true);
  await shot("templates-3-refused");

  // reset to default
  await page.locator("[data-template-generate]").fill("bunx create-vite@latest . --template react-swc-ts");
  await page.locator("[data-template-reset]").click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.waitForFunction(() => /^Vite \+ React/.test((document.querySelector('[data-template-name]') as HTMLInputElement | null)?.value ?? ""), null, { timeout: 8000 });
  check("Reset to default brings the shipped version back", true);

  // delete one and restore it
  await page.locator('[data-template-item="expo"] button').first().click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  await page.waitForSelector("[data-template-restore]", { timeout: 8000 });
  check("a deleted default offers Restore missing defaults", (await page.locator('[data-template-item="expo"]').count()) === 0);
  await page.locator("[data-template-restore]").click();
  await page.waitForSelector('[data-template-item="expo"]', { timeout: 8000 });
  check("and it comes back", true);

  // Edit once more so New app has something to show, then check the dialog reads the same store.
  await page.locator('[data-template-item="hono-api"] button').first().click();
  await page.locator("[data-template-name]").fill("Hono (edited)");
  // Attach a GitHub repo as the starter: the generator box is switched off and cleared, a bad URL is explained.
  await page.locator("[data-template-add-repo]").click();
  await page.getByLabel("Repo 1 URL").fill("https://gitlab.com/acme/starter");
  check("a non-GitHub URL is explained and blocks Save", (await page.locator("[data-template-save]").isDisabled()) && /not a GitHub/.test((await page.locator("[data-template-editor]").innerText())));
  await page.getByLabel("Repo 1 URL").fill("acme/starter");
  await page.getByLabel("Repo 1 hint").fill("keep the folder layout");
  check("a starter repo switches the generator off", (await page.locator("[data-template-generate]").isDisabled()) && (await page.locator("[data-template-generate]").inputValue()) === "");
  await shot("templates-5-repo");
  await page.locator("[data-template-save]").click();
  await page.waitForFunction(() => /Hono \(edited\)/.test(document.querySelector('[data-template-item="hono-api"]')?.textContent ?? ""), null, { timeout: 8000 });
  await page.goto(`${url}/`);
  await page.getByText("New app from a recipe").click();
  await page.waitForSelector("[data-recipe]", { timeout: 8000 });
  const names = await page.locator("[data-recipe]").allInnerTexts();
  check("New app lists the edited templates", names.some((n) => /Hono \(edited\)/.test(n)) && names.length === 4, names.map((n) => n.split("\n")[0]).join(" | "));
  check("the card says it starts from the repo", names.some((n) => /Hono \(edited\)/.test(n) && /from acme\/starter/.test(n)), names.join(" | ").slice(0, 200));
  const hono = (await (await fetch(`${url}/api/scaffold/recipes`, { headers: { authorization: `Bearer ${token}` } })).json()).recipes.find((r: any) => r.id === "hono-api");
  check("it is stored with the repo and no generator", hono.generate.length === 0 && hono.repos?.[0]?.url === "https://github.com/acme/starter" && hono.repos[0].role === "starter" && hono.repos[0].note === "keep the folder layout", JSON.stringify(hono.repos));
  await shot("templates-4-new-app");

  check("no page errors", errors.length === 0, errors.join("; ").slice(0, 200));
});

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
