/**
 * A session as one self-contained HTML file: inline CSS, no script, no network references, every piece of
 * text escaped, secrets redacted. Meant to be attached to a ticket or sent to a colleague.
 */
import os from "os";
import path from "path";
import { redact } from "./redact";
import type { Replay } from "./index";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Redact, hide the home directory, then escape: the order matters (escape last). */
function clean(s: string | null | undefined): string {
  if (!s) return "";
  let t = redact(s);
  const homeDir = os.homedir();
  if (homeDir && homeDir.length > 1) t = t.split(homeDir).join("~");
  return esc(t);
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c1e;--mut:#6b6b70;--line:#e2e2e6;--card:#f6f6f8;--acc:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--mut:#9a9aa3;--line:#2c2c31;--card:#1c1c20;--acc:#8b87ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 18px 80px}h1{font-size:20px;margin:0 0 4px}
.meta{color:var(--mut);font-size:12.5px;margin-bottom:22px}.turn{border-top:1px solid var(--line);padding-top:16px;margin-top:20px}
.turnhead{font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);margin-bottom:8px}
.user{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;white-space:pre-wrap;word-wrap:break-word}
.say{white-space:pre-wrap;word-wrap:break-word;margin:10px 0}details{margin:6px 0;border:1px solid var(--line);border-radius:8px;padding:4px 10px}
summary{cursor:pointer;color:var(--mut);font-size:12.5px}pre{margin:6px 0;white-space:pre-wrap;word-wrap:break-word;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace}
.tool{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--mut);padding:1px 0}.err{color:#d33}.foot{margin-top:40px;color:var(--mut);font-size:12px;border-top:1px solid var(--line);padding-top:12px}
`;

export function exportHtml(r: Replay, opts: { exportedAt?: string } = {}): string {
  const s = r.session;
  const turns = r.turns
    .map((t) => {
      const tools = t.items.filter((i) => i.kind === "tool");
      const body = t.items
        .filter((i) => i.kind === "text")
        .map((i) => `<div class="say">${clean(i.text)}</div>`)
        .join("");
      const answer = body || (t.output ? `<div class="say">${clean(t.output)}</div>` : "");
      const toolBlock = tools.length
        ? `<details><summary>${tools.length} tool call${tools.length === 1 ? "" : "s"}</summary>${tools.map((i) => `<div class="tool">${clean(i.name ?? "tool")} ${clean(i.arg ?? "")}</div>`).join("")}</details>`
        : "";
      const failed = t.status === "failed" || t.items.some((i) => i.kind === "fail") ? `<div class="tool err">turn ${esc(t.status)}</div>` : "";
      return `<section class="turn" id="turn-${t.seq}"><div class="turnhead">Turn ${t.seq} · ${esc(t.started_at)}${t.mode && t.mode !== "build" ? ` · ${esc(t.mode)}` : ""}</div><div class="user">${clean(t.prompt)}</div>${toolBlock}${answer}${failed}</section>`;
    })
    .join("\n");
  const where = path.basename(s.base_cwd);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${clean(s.title)} - session replay</title><style>${CSS}</style></head>
<body><main>
<h1>${clean(s.title)}</h1>
<div class="meta">${esc(s.engine)}${s.model ? ` · ${esc(s.model)}` : ""}${s.role ? ` · ${esc(s.role)}` : ""} · ${clean(where)} · ${esc(s.created_at)} · ${r.turns.length} turn${r.turns.length === 1 ? "" : "s"}</div>
${turns || '<p class="meta">No turns.</p>'}
<div class="foot">Exported from treeboss${opts.exportedAt ? ` on ${esc(opts.exportedAt)}` : ""}. Secrets that look like tokens or keys were redacted on a best-effort basis; read before sharing.</div>
</main></body></html>
`;
}
