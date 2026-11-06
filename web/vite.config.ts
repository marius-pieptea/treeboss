import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * In dev, the Vite server proxies /api to the running daemon and signs the requests with its token,
 * so `bun run dev:web` needs no sign-in dance. In production the daemon serves web/dist itself.
 */
function daemon(): { url: string; token: string } {
  const home = process.env.TRB_HOME ? path.resolve(process.env.TRB_HOME) : path.join(os.homedir(), ".treeboss");
  let url = "http://127.0.0.1:4477";
  try {
    url = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf-8")).url ?? url;
  } catch {}
  let token = "";
  try {
    token = fs.readFileSync(path.join(home, "token"), "utf-8").trim();
  } catch {}
  return { url, token };
}

const d = daemon();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: d.url,
        ws: true,
        changeOrigin: false,
        headers: { authorization: `Bearer ${d.token}` },
        // The daemon refuses a foreign Origin on cookie requests; the proxy authenticates by bearer instead.
        configure: (proxy) => proxy.on("proxyReq", (req) => req.removeHeader("origin")),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@codemirror") || id.includes("node_modules/@lezer")) return "codemirror";
          if (id.includes("node_modules/@xterm")) return "xterm";
          if (id.includes("node_modules/react-markdown") || id.includes("node_modules/remark") || id.includes("node_modules/micromark") || id.includes("node_modules/mdast") || id.includes("node_modules/unified")) return "markdown";
        },
      },
    },
  },
});
