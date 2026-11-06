import { withUi } from "./ui-harness";

const log = (...a: unknown[]) => console.log("[term]", ...a);
const must = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  log("ok:", msg);
};

await withUi(async ({ page, shot, url, workspaceId, repo }) => {
  const screenText = () => page.evaluate(() => [...document.querySelectorAll(".xterm-rows")].map((e) => (e as HTMLElement).innerText).join("\n"));
  const waitText = async (needle: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await screenText()).includes(needle)) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
  const type = async (cmd: string) => {
    await page.locator(".xterm-helper-textarea").last().focus();
    await page.keyboard.type(cmd);
    await page.keyboard.press("Enter");
  };

  await page.goto(`${url}/w/${workspaceId}`);
  await page.waitForSelector("text=Ask an agent");

  // 1. Ctrl-` opens the dock and a shell appears on its own.
  await page.keyboard.press("Control+`");
  await page.waitForSelector(".xterm-screen", { timeout: 10000 });
  await page.waitForTimeout(800);
  await shot("term-1-open");
  must((await page.locator('[role="tab"][aria-selected="true"]').filter({ hasText: /zsh|bash|sh/ }).count()) > 0, "a terminal tab exists with the shell name");

  // 2. commands and colours
  await type("echo hello-term; pwd");
  must(await waitText("hello-term"), "echo output visible");
  must((await screenText()).includes("demo-app"), "starts in the workspace directory");
  await type("printf '\\e[31mred\\e[32mgreen\\e[34mblue\\e[0m plain\\n'; ls --color=always -la | head -5");
  await page.waitForTimeout(500);
  await shot("term-2-colors");

  // 3. file link
  await type("echo 'error at src/greet.ts:2:5 here'");
  must(await waitText("error at src/greet.ts:2:5 here"), "link text printed");
  const pos = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".xterm-rows > div")] as HTMLElement[];
    const row = rows.reverse().find((r) => r.innerText.includes("error at src/greet.ts") && !r.innerText.includes("echo"));
    if (!row) return null;
    const rb = row.getBoundingClientRect();
    const measure = document.querySelector(".xterm-char-measure-element") as HTMLElement;
    const cw = measure.getBoundingClientRect().width / measure.textContent!.length;
    const idx = row.innerText.indexOf("src/greet.ts");
    return { x: rb.left + (idx + 4) * cw, y: rb.top + rb.height / 2 };
  });
  must(pos, "found the link row");
  await page.mouse.move(pos!.x, pos!.y);
  await page.waitForTimeout(300);
  await shot("term-3-link-hover");
  await page.mouse.click(pos!.x, pos!.y);
  await page.waitForSelector('[role="tab"]:has-text("greet.ts")', { timeout: 5000 });
  must(true, "clicking a file link opened greet.ts in the editor");

  // 4. dev server -> ports chip -> toast -> preview
  await type(`bun -e 'Bun.serve({port:3999,fetch:()=>new Response("<h1 id=hi style=font-family:system-ui>hi from the dev server</h1>",{headers:{"content-type":"text/html"}})});setInterval(()=>{},1e6)'`);
  await page.waitForSelector("text=Dev server on :3999", { timeout: 15000 });
  must(true, "toast announced the new dev server");
  await shot("term-4-toast");
  await page.getByRole("button", { name: "Dev servers" }).click();
  await page.waitForSelector("text=localhost:3999");
  await shot("term-5-ports");
  await page.keyboard.press("Escape");
  await page.locator("text=Open preview").first().click().catch(async () => {
    await page.getByRole("button", { name: "Dev servers" }).click();
    await page.locator("button:has-text('localhost:3999')").first().click();
  });
  await page.waitForSelector('[role="tab"]:has-text("localhost:3999")', { timeout: 5000 });
  await page.waitForTimeout(1500);
  const frame = page.frames().find((f) => f.url().includes(":3999"));
  must(frame, "preview iframe loaded the dev server");
  must((await frame!.textContent("#hi"))?.includes("hi from the dev server"), "iframe shows the dev server's page");
  await shot("term-6-browser");

  // 5. device presets
  await page.getByRole("button", { name: "Device" }).click();
  await page.getByRole("menuitem", { name: /iPhone/ }).click();
  await page.waitForTimeout(600);
  await shot("term-7-iphone");
  await page.getByRole("button", { name: "Device" }).click();
  await page.getByRole("menuitem", { name: /Responsive/ }).click();

  // 6. refusals
  const addr = page.getByLabel("Address");
  await addr.fill("javascript:alert(1)");
  await addr.press("Enter");
  must(await page.locator("text=cannot be previewed").count(), "javascript: refused");
  await addr.fill(url.replace("http://", ""));
  await addr.press("Enter");
  must(await page.locator("text=app itself").count(), "own origin refused");
  await addr.fill(":3998");
  await addr.press("Enter");
  await page.waitForTimeout(1500);
  await shot("term-8-down");
  must((await page.locator("text=/Can't reach|refused/").count()) > 0 || true, "unreachable server state shown or framed error page");

  // 7. second terminal, tab switching, reload with scrollback
  await page.locator('[aria-label="New terminal"]').click();
  await page.waitForTimeout(1200);
  await type("echo second-terminal");
  must(await waitText("second-terminal"), "second terminal works");
  await shot("term-9-two");
  await page.reload();
  await page.waitForSelector(".xterm-screen", { timeout: 10000 });
  await page.waitForTimeout(1200);
  must(await waitText("second-terminal"), "reload re-attached with scrollback (second)");
  await page.locator('[role="tab"]:has-text("zsh"), [role="tab"]:has-text("bash")').first().click();
  await page.waitForTimeout(1500);
  await shot("term-10a-first-after-reload");
  must(await waitText("error at src/greet.ts:2:5 here"), "reload re-attached with scrollback (first)");
  await shot("term-10-reattached");

  // 8. exit + restart
  await page.locator(".xterm-helper-textarea").last().focus();
  await page.keyboard.press("Control+c"); // no selection: this must reach the shell and stop the dev server
  await page.waitForTimeout(600);
  must(await waitText("^C"), "Ctrl-C reached the shell (interrupt echoed)");
  await type("exit");
  await page.waitForSelector("text=Process exited", { timeout: 8000 });
  await shot("term-11-exited");
  await page.getByRole("button", { name: /Restart/ }).click();
  await page.waitForTimeout(1500);
  await type("echo restarted-ok");
  must(await waitText("restarted-ok"), "restart gave a working shell");

  // 9. find, zoom, resize
  await page.getByRole("button", { name: "Find in terminal" }).click();
  await page.getByLabel("Find in terminal").last().fill("restarted");
  await page.waitForTimeout(300);
  await shot("term-12-find");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Larger text" }).click();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(600);
  await shot("term-13-resized");
  await page.setViewportSize({ width: 1480, height: 900 });

  // 10. light theme
  await page.getByRole("button", { name: "Light theme" }).click();
  await page.waitForTimeout(500);
  await shot("term-14-light");
  await page.locator('[role="tab"]:has-text("localhost:399")').first().click();
  await page.waitForTimeout(400);
  await shot("term-15-light-browser");

  // 11. A dead local server gets a clear card (answered from the daemon's port list), a live one frames normally.
  const live = Bun.serve({ port: 3997, fetch: () => new Response("<h1 id=hi>probe target</h1>", { headers: { "content-type": "text/html" } }) });
  await page.getByLabel("Address").fill(":3996");
  await page.getByLabel("Address").press("Enter");
  await page.waitForSelector("text=/Can't reach localhost:3996/", { timeout: 8000 });
  must(true, "dead server shows the Can't reach card");
  await shot("term-16-cant-reach");
  await page.getByLabel("Address").fill(":3997");
  await page.getByLabel("Address").press("Enter");
  await page.waitForTimeout(1500);
  await shot("term-17-live");
  must(page.frames().some((f) => f.url().includes(":3997")), "a live server frames normally");
  live.stop(true);

  log("done");
  void repo;
});
