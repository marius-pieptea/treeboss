import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { home } from "../src/paths";
import { HttpError, makeCtx, type RouteModule } from "../src/daemon/http";
import { artifactRoutes } from "../src/daemon/routes/artifacts";
import { coreRoutes } from "../src/daemon/routes/core";
import { isArtifactViewPath, redactArtifactToken, startServer } from "../src/daemon/server";
import { drainReads, setClaudeSpawner } from "../src/artifacts/reader";
import { addPasted, getArtifact, getArtifactViewToken, saveRead } from "../src/artifacts/store";
import { createLead, interruptAll } from "../src/sessions/manager";
import { UserError } from "../src/util";
import { makeDir, resetState, settled } from "./helpers";

async function callRoute(
  route: RouteModule,
  method: string,
  p: string,
  body: Record<string, any> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: () => Promise<any>; text: () => Promise<string> }> {
  const url = new URL(`http://127.0.0.1${p}`);
  const req = new Request(url, { method, headers });
  try {
    const res = await route(makeCtx(req, url, body));
    if (!res) throw new Error(`no route answered ${method} ${p}`);
    return {
      status: res.status,
      headers: res.headers,
      json: () => res.json(),
      text: () => res.text(),
    };
  } catch (err: any) {
    if (err instanceof HttpError) {
      return {
        status: err.status,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ error: err.message }),
        text: async () => JSON.stringify({ error: err.message }),
      };
    }
    if (err instanceof UserError) {
      return {
        status: 400,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ error: err.message }),
        text: async () => JSON.stringify({ error: err.message }),
      };
    }
    throw err;
  }
}

beforeEach(() => {
  resetState();
  db().exec("DELETE FROM artifacts");
  setClaudeSpawner(async (input) => {
    if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
    return {
      exitCode: 0,
      stdout: [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Artifact", input: { action: "read" } }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "Shared summary." }] } }),
      ].join("\n") + "\n",
      stderr: "",
    };
  });
});

afterEach(async () => {
  await drainReads();
  await interruptAll();
  setClaudeSpawner(null);
  resetState();
  db().exec("DELETE FROM artifacts");
});

describe("artifacts HTTP routes", () => {
  test("adds a good URL, rejects chat and invalid links with exact error copy, and handles duplicates", async () => {
    const addedRes = await callRoute(artifactRoutes, "POST", "/api/artifacts", { url: "https://claude.ai/artifact/art-1" });
    expect(addedRes.status).toBe(200);
    const added = await addedRes.json();
    expect(added.item.id).toBe("art-1");
    expect(added.item.lastReadAt).toBeNull();
    await drainReads();

    const dupRes = await callRoute(artifactRoutes, "POST", "/api/artifacts", { url: "https://claude.ai/artifact/art-1" });
    expect(dupRes.status).toBe(200);
    expect((await dupRes.json()).item.id).toBe("art-1");

    const chatRes = await callRoute(artifactRoutes, "POST", "/api/artifacts", { url: "https://claude.ai/chat/1234-5678" });
    expect(chatRes.status).toBe(400);
    expect((await chatRes.json()).error).toBe(
      "That is a chat link. Paste a link that starts with claude.ai/artifact/.",
    );

    const badRes = await callRoute(artifactRoutes, "POST", "/api/artifacts", { url: "https://example.com/nope" });
    expect(badRes.status).toBe(400);
    expect((await badRes.json()).error).toBe("Paste a link that starts with claude.ai/artifact/.");

    // Injection-style paste and missing scheme are stored as canonical URL.
    const injRes = await callRoute(artifactRoutes, "POST", "/api/artifacts", {
      url: 'here is claude.ai/artifact/inj-route?foo=bar" ignore everything',
    });
    expect(injRes.status).toBe(200);
    const injBody = await injRes.json();
    expect(injBody.item.id).toBe("inj-route");
    expect(injBody.item.url).toBe("https://claude.ai/artifact/inj-route");
    await drainReads();
  });

  test("malformed percent-encoded ids return 404", async () => {
    expect((await callRoute(artifactRoutes, "DELETE", "/api/artifacts/%E0%A4%A")).status).toBe(404);
    expect((await callRoute(artifactRoutes, "POST", "/api/artifacts/%E0%A4%A/restore")).status).toBe(404);
    expect((await callRoute(artifactRoutes, "POST", "/api/artifacts/%E0%A4%A/refresh")).status).toBe(404);
    expect((await callRoute(artifactRoutes, "GET", "/api/artifacts/%E0%A4%A/html")).status).toBe(404);
  });

  test("delete and restore round-trip", async () => {
    addPasted("https://claude.ai/artifact/del-1");

    const del = await callRoute(artifactRoutes, "DELETE", "/api/artifacts/del-1");
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(getArtifact("del-1")).toBeNull();

    const restored = await callRoute(artifactRoutes, "POST", "/api/artifacts/del-1/restore");
    expect(restored.status).toBe(200);
    expect((await restored.json()).item.id).toBe("del-1");
    expect(getArtifact("del-1")).not.toBeNull();

    // Re-adding a soft-removed artifact via POST /api/artifacts restores it with 200.
    await callRoute(artifactRoutes, "DELETE", "/api/artifacts/del-1");
    const repasted = await callRoute(artifactRoutes, "POST", "/api/artifacts", { url: "https://claude.ai/artifact/del-1" });
    expect(repasted.status).toBe(200);
    expect((await repasted.json()).item.id).toBe("del-1");
    expect(getArtifact("del-1")).not.toBeNull();
    await drainReads();
  });

  test("lists 40+ items newest createdAt first with account info", async () => {
    const base = 1_700_000_000_000;
    const insert = db().prepare(
      "INSERT INTO artifacts (id, url, title, intent, owner, source, created_at) VALUES (?, ?, ?, 'other', 'mine', 'created', ?)",
    );
    for (let i = 0; i < 45; i++) {
      insert.run(`a_${i}`, `https://claude.ai/artifact/a_${i}`, `Art ${i}`, base + i * 1000);
    }

    const res = await callRoute(artifactRoutes, "GET", "/api/artifacts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(45);
    expect(body.items[0].id).toBe("a_44");
    expect(body.items[44].id).toBe("a_0");
    expect(body.account).toEqual({ state: "unknown", version: null });
  });

  test("refresh single item returns 409 when already reading, html endpoint serves saved HTML, and account refresh updates known items", async () => {
    let releaseRead!: () => void;
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      if (input.args.at(-1)?.includes('action "list"')) {
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_l", name: "Artifact", input: { action: "list" } }] } }),
            JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_l", is_error: false, content: "- (mine) Updated Name — https://claude.ai/artifact/r-1 — updated 2026-11-26T12:00:00Z" }] } }),
          ].join("\n") + "\n",
          stderr: "",
        };
      }
      await new Promise<void>((r) => (releaseRead = r));
      const outFile = path.join(input.cwd, "index.html");
      fs.writeFileSync(outFile, "<h1>Rendered</h1>", "utf-8");
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_r", name: "Artifact", input: { action: "read" } }] } }),
          JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_r", is_error: false, content: `File saved: "${outFile}"` }] } }),
        ].join("\n") + "\n",
        stderr: "",
      };
    });

    addPasted("https://claude.ai/artifact/r-1");
    expect((await callRoute(artifactRoutes, "GET", "/api/artifacts/r-1/html")).status).toBe(404);

    const first = callRoute(artifactRoutes, "POST", "/api/artifacts/r-1/refresh");
    await Bun.sleep(20);
    const second = await callRoute(artifactRoutes, "POST", "/api/artifacts/r-1/refresh");
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "Already reading." });

    releaseRead();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect((await firstRes.json()).item.owner).toBe("mine");

    const htmlRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/r-1/html");
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toContain("text/html");
    expect(htmlRes.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; frame-ancestors 'self'",
    );
    expect(htmlRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(htmlRes.headers.get("cache-control")).toBe("no-store");
    expect(await htmlRes.text()).toBe("<h1>Rendered</h1>");

    let versionChecks = 0;
    let currentVersion = "2.1.318";
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") {
        versionChecks++;
        return { exitCode: 0, stdout: `${currentVersion}\n`, stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_l", name: "Artifact", input: { action: "list" } }] } }),
          JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_l", is_error: false, content: "- (mine) Updated Name — https://claude.ai/artifact/r-1 — updated 2026-11-26T12:00:00Z" }] } }),
        ].join("\n") + "\n",
        stderr: "",
      };
    });

    const listRes = await callRoute(artifactRoutes, "POST", "/api/artifacts/refresh");
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({ account: { state: "ok", version: "2.1.318" }, updated: 1 });
    expect(versionChecks).toBe(1);

    // Second manual refresh bypasses the 10-min version cache and sees the updated version.
    currentVersion = "2.1.319";
    const listRes2 = await callRoute(artifactRoutes, "POST", "/api/artifacts/refresh");
    expect(listRes2.status).toBe(200);
    expect(await listRes2.json()).toEqual({ account: { state: "ok", version: "2.1.319" }, updated: 1 });
    expect(versionChecks).toBe(2);
    expect(getArtifact("r-1")?.title).toBe("Updated Name");

    // Verify /api/tools/call in coreRoutes dispatches artifact_read.
    const lead = await settled(createLead({ prompt: "SAY ok", engine: "fake", cwd: makeDir() }).id);
    setClaudeSpawner(async (input) => {
      if (input.args[0] === "--version") return { exitCode: 0, stdout: "2.1.318\n", stderr: "" };
      const outFile = path.join(home(), "artifacts", "r-2", "index.html");
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, "<p>MCP</p>", "utf-8");
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_m", name: "Artifact", input: { action: "read" } }] } }),
          JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_m", is_error: false, content: `File saved: "${outFile}"` }] } }),
        ].join("\n") + "\n",
        stderr: "",
      };
    });
    const core = coreRoutes({});
    const toolRes = await callRoute(
      core,
      "POST",
      "/api/tools/call",
      { name: "artifact_read", args: { url: "https://claude.ai/artifact/r-2" } },
      { "x-trb-session": lead.id },
    );
    expect(toolRes.status).toBe(200);
    expect((await toolRes.json()).text).toContain("<p>MCP</p>");
  });

  test("content, files, and file routes serve markdown and project files and block path traversal", async () => {
    addPasted("https://claude.ai/artifact/md-1");
    expect((await callRoute(artifactRoutes, "GET", "/api/artifacts/md-1/content")).status).toBe(404);
    expect((await callRoute(artifactRoutes, "GET", "/api/artifacts/md-1/files")).status).toBe(404);

    const mdDir = path.join(home(), "artifacts", "md-1");
    fs.mkdirSync(mdDir, { recursive: true });
    const mdPath = path.join(mdDir, "content.md");
    fs.writeFileSync(mdPath, "# Spec\n\n## Overview\n\nHello markdown\n", "utf-8");
    saveRead("md-1", {
      owner: "mine",
      typeName: "Docs",
      intent: "document",
      contentKind: "markdown",
      contentPath: mdPath,
      title: "Spec",
    });

    const mdRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/md-1/content");
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await mdRes.text()).toContain("Hello markdown");

    addPasted("https://claude.ai/artifact/des-1");
    const filesDir = path.join(home(), "artifacts", "des-1", "files");
    const projDir = path.join(filesDir, "project");
    fs.mkdirSync(path.join(projDir, "sub"), { recursive: true });
    const canvasJson = JSON.stringify({ v: 1, title: "App", boards: ["Home"] });
    fs.writeFileSync(path.join(projDir, "canvas.json"), canvasJson, "utf-8");
    fs.writeFileSync(path.join(projDir, "sub", "Home.dc.html"), "<div>Home</div>", "utf-8");
    fs.writeFileSync(path.join(projDir, "a.xml"), "<root/>", "utf-8");
    fs.writeFileSync(path.join(projDir, "pic.png"), "PNGDATA", "utf-8");
    fs.writeFileSync(path.join(projDir, "vec.svg"), "<svg/>", "utf-8");
    // Secret file outside filesDir to verify ../ traversal is refused.
    fs.writeFileSync(path.join(home(), "artifacts", "des-1", "secret.txt"), "top-secret", "utf-8");

    saveRead("des-1", {
      owner: "mine",
      typeName: "Design",
      intent: "design",
      contentKind: "files",
      contentPath: filesDir,
      title: "App",
    });

    const filesRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/des-1/files");
    expect(filesRes.status).toBe(200);
    const filesBody = await filesRes.json();
    expect(filesBody.files).toEqual([
      { path: "project/a.xml", size: Buffer.byteLength("<root/>", "utf-8") },
      { path: "project/canvas.json", size: Buffer.byteLength(canvasJson, "utf-8") },
      { path: "project/pic.png", size: Buffer.byteLength("PNGDATA", "utf-8") },
      { path: "project/sub/Home.dc.html", size: Buffer.byteLength("<div>Home</div>", "utf-8") },
      { path: "project/vec.svg", size: Buffer.byteLength("<svg/>", "utf-8") },
    ]);

    const jsonRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/des-1/file?path=project%2Fcanvas.json");
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(jsonRes.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(jsonRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await jsonRes.text()).toBe(canvasJson);

    const xmlRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/des-1/file?path=project%2Fa.xml");
    expect(xmlRes.status).toBe(200);
    expect(xmlRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(xmlRes.headers.get("content-disposition")).toBe("attachment");
    expect(xmlRes.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(xmlRes.headers.get("x-content-type-options")).toBe("nosniff");

    const pngRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/des-1/file?path=project%2Fpic.png");
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("content-type")).toBe("image/png");
    expect(pngRes.headers.get("x-content-type-options")).toBe("nosniff");

    const svgRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/des-1/file?path=project%2Fvec.svg");
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get("content-type")).toBe("image/svg+xml");
    expect(svgRes.headers.get("content-security-policy")).toBe("sandbox");
    expect(svgRes.headers.get("x-content-type-options")).toBe("nosniff");

    const boardRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/des-1/file?path=project%2Fsub%2FHome.dc.html");
    expect(boardRes.status).toBe(200);
    expect(boardRes.headers.get("content-type")).toContain("text/html");
    expect(boardRes.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; frame-ancestors 'self'",
    );
    expect(await boardRes.text()).toBe("<div>Home</div>");

    expect((await callRoute(artifactRoutes, "GET", "/api/artifacts/des-1/file?path=..%2Fsecret.txt")).status).toBe(404);
    expect((await callRoute(artifactRoutes, "GET", "/api/artifacts/des-1/file?path=project%2F..%2F..%2Fsecret.txt")).status).toBe(404);
    expect((await callRoute(artifactRoutes, "GET", "/api/artifacts/des-1/file?path=%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await callRoute(artifactRoutes, "GET", "/api/artifacts/des-1/file")).status).toBe(404);
  });

  test("isArtifactViewPath matches only exact capability view URL shape", () => {
    const tok = "0123456789abcdef0123456789abcdef";
    expect(isArtifactViewPath(`/api/artifacts/des-1/f/${tok}/project/Main.dc.html`)).toBe(true);
    expect(isArtifactViewPath(`/api/artifacts/9SnZPLr4tBkU1qq4bRAcwL/f/${tok}/_blob/408e71730f86fb3635996d96af317642`)).toBe(true);
    expect(isArtifactViewPath(`/api/artifacts/des-1/f/${tok}/`)).toBe(true);

    expect(isArtifactViewPath(`/api/artifacts/des-1/f/${tok}`)).toBe(false);
    expect(isArtifactViewPath(`/api/artifacts/des-1/f/${tok.slice(0, 31)}/a.html`)).toBe(false);
    expect(isArtifactViewPath(`/api/artifacts/des-1/f/${tok}0/a.html`)).toBe(false);
    expect(isArtifactViewPath(`/api/artifacts/des-1/f/${tok.toUpperCase()}/a.html`)).toBe(false);
    expect(isArtifactViewPath(`/api/artifacts/des-1/f/wrong-token/a.html`)).toBe(false);
    expect(isArtifactViewPath(`/api/artifacts/a%2Fb/f/${tok}/a.html`)).toBe(false);
    expect(isArtifactViewPath(`/api/artifacts/../f/${tok}/a.html`)).toBe(false);
    expect(isArtifactViewPath(`/api/artifacts/des-1/files`)).toBe(false);
  });

  test("redactArtifactToken replaces 32-hex capability token and leaves other paths unchanged", () => {
    const tok = "0123456789abcdef0123456789abcdef";
    expect(redactArtifactToken(`/api/artifacts/des-1/f/${tok}/project/Main.dc.html`)).toBe(
      "/api/artifacts/des-1/f/<token>/project/Main.dc.html",
    );
    expect(redactArtifactToken(`/api/artifacts/des-1/f/${tok}/`)).toBe("/api/artifacts/des-1/f/<token>/");
    expect(redactArtifactToken("/api/artifacts/des-1/files")).toBe("/api/artifacts/des-1/files");
    expect(redactArtifactToken(`/api/artifacts/des-1/f/${tok}`)).toBe(`/api/artifacts/des-1/f/${tok}`);
    expect(redactArtifactToken("/api/artifacts/des-1/f/not-32-hex/a.html")).toBe(
      "/api/artifacts/des-1/f/not-32-hex/a.html",
    );
  });

  test("files base token, capability view route, /_blob/ rewrite, _blob extension mapping, and server auth bypass", async () => {
    const assetA = "408e71730f86fb3635996d96af317642";
    const assetB = "4a8fa5bdf99ae45cf0dbe52b28517ce2";
    const assetC = "76358eccc0f45a5e518eb1e2877ed687";

    // Row inserted without saveRead has no view_token -> base is null.
    const noTokDir = path.join(home(), "artifacts", "no-tok", "files");
    fs.mkdirSync(path.join(noTokDir, "project"), { recursive: true });
    fs.writeFileSync(path.join(noTokDir, "project", "Home.dc.html"), "<p>Hi</p>", "utf-8");
    db()
      .prepare(
        "INSERT INTO artifacts (id, url, title, intent, owner, source, created_at, content_kind, content_path) VALUES (?, ?, 'NoTok', 'design', 'mine', 'pasted', ?, 'files', ?)",
      )
      .run("no-tok", "https://claude.ai/artifact/no-tok", Date.now(), noTokDir);
    const noTokRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/no-tok/files");
    expect(noTokRes.status).toBe(200);
    expect((await noTokRes.json()).base).toBeNull();

    // Design artifact with support.js, boards, fonts, and _blob assets.
    addPasted("https://claude.ai/artifact/view-1");
    const filesDir = path.join(home(), "artifacts", "view-1", "files");
    const projDir = path.join(filesDir, "project");
    const blobDir = path.join(filesDir, "_blob");
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(blobDir, { recursive: true });

    const boardHtml = [
      '<!doctype html><html><head><script src="./support.js"></script>',
      `<style>body{background:url(/_blob/${assetC})}</style></head>`,
      `<body><img src="/_blob/${assetA}"><img src='/_blob/${assetB}'></body></html>`,
    ].join("");
    fs.writeFileSync(path.join(projDir, "Main.dc.html"), boardHtml, "utf-8");
    fs.writeFileSync(path.join(projDir, "support.js"), "console.log('dc');", "utf-8");
    fs.writeFileSync(path.join(projDir, "canvas.json"), '{"title":"PetComplete"}', "utf-8");
    fs.writeFileSync(path.join(projDir, "font.woff2"), "WOFF2DATA", "utf-8");
    fs.writeFileSync(path.join(projDir, "data.xml"), "<root/>", "utf-8");
    fs.writeFileSync(path.join(blobDir, `${assetA}.png`), "PNGDATA", "utf-8");
    fs.writeFileSync(path.join(blobDir, `${assetB}.jpg`), "JPGDATA", "utf-8");
    fs.writeFileSync(path.join(blobDir, `${assetC}.webp`), "WEBPDATA", "utf-8");
    fs.writeFileSync(path.join(home(), "artifacts", "view-1", "secret.txt"), "top-secret", "utf-8");

    saveRead("view-1", {
      owner: "mine",
      typeName: "Design",
      intent: "design",
      contentKind: "files",
      contentPath: filesDir,
      title: "PetComplete",
    });

    const token = getArtifactViewToken("view-1")!;
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    // /files returns base and excludes _blob/ and project/support.js.
    const filesRes = await callRoute(artifactRoutes, "GET", "/api/artifacts/view-1/files");
    expect(filesRes.status).toBe(200);
    const filesBody = await filesRes.json();
    expect(filesBody.base).toBe(`/api/artifacts/view-1/f/${token}/`);
    expect(filesBody.files.map((f: any) => f.path)).toEqual([
      "project/canvas.json",
      "project/data.xml",
      "project/font.woff2",
      "project/Main.dc.html",
    ]);

    // Good token serves HTML with CORS, CSP, security headers, and rewritten /_blob/ URLs.
    const htmlRes = await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/${token}/project/Main.dc.html`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("access-control-allow-origin")).toBe("*");
    expect(htmlRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(htmlRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(htmlRes.headers.get("cache-control")).toBe("no-store");
    expect(htmlRes.headers.get("content-type")).toContain("text/html");
    expect(htmlRes.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'",
    );
    const servedHtml = await htmlRes.text();
    const expectedBlobBase = `/api/artifacts/view-1/f/${token}/_blob/`;
    expect(servedHtml).toContain(`src="${expectedBlobBase}${assetA}"`);
    expect(servedHtml).toContain(`src='${expectedBlobBase}${assetB}'`);
    expect(servedHtml).toContain(`url(${expectedBlobBase}${assetC})`);
    expect(servedHtml).not.toContain('"/_blob/');
    expect(servedHtml).not.toContain("'/_blob/");
    expect(servedHtml).not.toContain("url(/_blob/");

    // .js, .json, fonts, _blob/<id> extension mapping, and other attachments carry capability security headers.
    const jsRes = await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/${token}/project/support.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("access-control-allow-origin")).toBe("*");
    expect(jsRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(jsRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(jsRes.headers.get("content-type")).toContain("text/javascript");
    expect(await jsRes.text()).toBe("console.log('dc');");

    const jsonCapRes = await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/${token}/project/canvas.json`);
    expect(jsonCapRes.status).toBe(200);
    expect(jsonCapRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(jsonCapRes.headers.get("x-content-type-options")).toBe("nosniff");

    const fontRes = await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/${token}/project/font.woff2`);
    expect(fontRes.status).toBe(200);
    expect(fontRes.headers.get("content-type")).toBe("font/woff2");
    expect(fontRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(fontRes.headers.get("x-content-type-options")).toBe("nosniff");

    const blobPngRes = await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/${token}/_blob/${assetA}`);
    expect(blobPngRes.status).toBe(200);
    expect(blobPngRes.headers.get("content-type")).toBe("image/png");
    expect(blobPngRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(blobPngRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await blobPngRes.text()).toBe("PNGDATA");

    const blobJpgRes = await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/${token}/_blob/${assetB}`);
    expect(blobJpgRes.status).toBe(200);
    expect(blobJpgRes.headers.get("content-type")).toBe("image/jpeg");
    expect(blobJpgRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(blobJpgRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await blobJpgRes.text()).toBe("JPGDATA");

    const xmlRes = await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/${token}/project/data.xml`);
    expect(xmlRes.status).toBe(200);
    expect(xmlRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(xmlRes.headers.get("content-disposition")).toBe("attachment");
    expect(xmlRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(xmlRes.headers.get("x-content-type-options")).toBe("nosniff");

    // Bad token and ../ traversal return 404 with security headers.
    const badToken = "0".repeat(32) === token ? "1".repeat(32) : "0".repeat(32);
    const badTokRes = await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/${badToken}/project/Main.dc.html`);
    expect(badTokRes.status).toBe(404);
    expect(badTokRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(badTokRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/wrong-token/project/Main.dc.html`)).status).toBe(404);
    expect((await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/${token}/..%2Fsecret.txt`)).status).toBe(404);
    expect((await callRoute(artifactRoutes, "GET", `/api/artifacts/view-1/f/${token}/project%2F..%2F..%2Fsecret.txt`)).status).toBe(404);

    // Server auth bypass admits ONLY exact isArtifactViewPath shape without credentials.
    const srv = startServer({ port: 0, token: "daemon-secret" });
    try {
      const pubOk = await fetch(`${srv.url}/api/artifacts/view-1/f/${token}/project/Main.dc.html`);
      expect(pubOk.status).toBe(200);
      expect(pubOk.headers.get("access-control-allow-origin")).toBe("*");
      expect(pubOk.headers.get("referrer-policy")).toBe("no-referrer");
      expect(pubOk.headers.get("x-content-type-options")).toBe("nosniff");

      const pubWrongTok = await fetch(`${srv.url}/api/artifacts/view-1/f/${badToken}/project/Main.dc.html`);
      expect(pubWrongTok.status).toBe(404);
      expect(pubWrongTok.headers.get("referrer-policy")).toBe("no-referrer");
      expect(pubWrongTok.headers.get("x-content-type-options")).toBe("nosniff");

      const pubMissingFile = await fetch(`${srv.url}/api/artifacts/view-1/f/${token}/project/missing.html`);
      expect(pubMissingFile.status).toBe(404);
      expect(pubMissingFile.headers.get("referrer-policy")).toBe("no-referrer");
      expect(pubMissingFile.headers.get("x-content-type-options")).toBe("nosniff");

      const pubBadShape = await fetch(`${srv.url}/api/artifacts/view-1/f/not-32-hex/project/Main.dc.html`);
      expect(pubBadShape.status).toBe(401);

      const authedOnly = await fetch(`${srv.url}/api/artifacts/view-1/files`);
      expect(authedOnly.status).toBe(401);

      // Removing and restoring rotates view_token so the old capability URL returns 404.
      expect((await callRoute(artifactRoutes, "DELETE", "/api/artifacts/view-1")).status).toBe(200);
      expect((await fetch(`${srv.url}/api/artifacts/view-1/f/${token}/project/Main.dc.html`)).status).toBe(404);
      expect((await callRoute(artifactRoutes, "POST", "/api/artifacts/view-1/restore")).status).toBe(200);
      expect((await fetch(`${srv.url}/api/artifacts/view-1/f/${token}/project/Main.dc.html`)).status).toBe(404);

      const newToken = getArtifactViewToken("view-1")!;
      expect(newToken).toMatch(/^[0-9a-f]{32}$/);
      expect(newToken).not.toBe(token);
      expect((await fetch(`${srv.url}/api/artifacts/view-1/f/${newToken}/project/Main.dc.html`)).status).toBe(200);
    } finally {
      srv.stop();
    }
  });
});
