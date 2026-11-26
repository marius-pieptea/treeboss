# Analiză: Tab „Artifacts” general, independent de engine

Scopul real: un artefact creat într-o sesiune (design, analiză, document, slide-uri) să poată fi previzualizat în TreeBoss și **refolosit ca context** în altă sesiune, cu orice engine, fără screenshot-uri și fără dependență de contul `claude.ai`.

---

## 1. Ce are deja TreeBoss reutilizabil

- **Evidence store** ([src/evidence/store.ts](file:///src/evidence/store.ts#L1-L120), [src/evidence/defs.ts](file:///src/evidence/defs.ts#L5-L60), [src/evidence/tools.ts](file:///src/evidence/tools.ts#L1-L60), [src/daemon/routes/evidence.ts](file:///src/daemon/routes/evidence.ts#L1-L80), [src/db.ts](file:///src/db.ts#L173-L187)): stocare per-proiect (`workspaceKey`), fișiere grele sub `~/.treeboss/evidence/<id>/` + index SQLite, tool-uri MCP (`evidence_read`, `evidence_note` etc.) și servire izolată (`sandbox`, `nosniff`).
- **Viewere Docs / Specs / Plans și Attachments** ([src/daemon/routes/docs.ts](file:///src/daemon/routes/docs.ts#L1-L80), [src/daemon/routes/specs.ts](file:///src/daemon/routes/specs.ts#L1-L45), [src/daemon/routes/attachments.ts](file:///src/daemon/routes/attachments.ts#L1-L79), [src/attachments/index.ts](file:///src/attachments/index.ts#L1-L80)): atașare unificată la sesiuni (`attachAny` cu mod `ref` sau `inline` și estimare de tokeni) + randare Markdown (`ReactMarkdown` + `remarkGfm` în [DocPreview.tsx](file:///web/src/features/artifacts/DocPreview.tsx#L55-L69)).
- **Design canvas și `.dc.html`** ([src/design/sessions.ts](file:///src/design/sessions.ts#L1-L120), [src/design/guidance.ts](file:///src/design/guidance.ts#L12), [src/daemon/routes/design.ts](file:///src/daemon/routes/design.ts#L1-L80), [FilesPreview.tsx](file:///web/src/features/artifacts/FilesPreview.tsx#L25-L100)): generare `design/directions.html` self-contained și suport existent în tab-ul Artifacts pentru `canvas.json` și board-uri `.dc.html` multi-fișier.
- **Rutele `/api/artifacts` și sandbox CSP** ([src/daemon/routes/artifacts.ts](file:///src/daemon/routes/artifacts.ts#L39-L45), [L71-L227](file:///src/daemon/routes/artifacts.ts#L71-L227), [Detail.tsx](file:///web/src/features/artifacts/Detail.tsx#L245-L252)): `HTML_HEADERS` (`sandbox allow-scripts; default-src 'none'; connect-src 'none'; frame-ancestors 'self'`), protecție path traversal (`resolveArtifactFile`), servire `html`, `content` (Markdown), `files`/`file` și `<iframe sandbox="allow-scripts">`.
- **Înregistrarea MCP `trb`** ([src/mcp/serve.ts](file:///src/mcp/serve.ts#L44-L58), [src/mcp/store.ts](file:///src/mcp/store.ts#L158-L186), [src/daemon/routes/core.ts](file:///src/daemon/routes/core.ts#L114-L133)): shim-ul stdio `trb mcp-serve` este injectat per turn prin `buildRunMcpConfig` cu `TRB_SESSION` și `TRB_ARTIFACTS`, iar `/api/tools/call` rutează `ARTIFACT_TOOL_SET` către [src/artifacts/tools.ts](file:///src/artifacts/tools.ts#L21-L93).

---

## 2. Opțiuni analizate

### a) Store local, engine-agnostic în TreeBoss (recomandat)
- **Cum funcționează:** extindem serverul MCP `trb` cu `artifact_publish`, `artifact_update`, `artifact_list` (lângă `artifact_read`). Orice agent scrie conținut (`html`, `markdown`, `files`/`.dc.html` sau slide-uri HTML) în `~/.treeboss/artifacts/<id>/v<N>/` (sau în repo dacă e marcat ca partajat în git), indexat în tabela `artifacts` cu versionare și afișat în același tab lângă cele de pe `claude.ai`.
- **Engine-uri acoperite:** `claude`, `codex`, `cursor`, `opencode`, `devin` și `agy` (toate primesc `trb` MCP în [src/engines/registry.ts](file:///src/engines/registry.ts#L222-L490); `agy` prin `.agents/mcp_config.json` la [L373-L375](file:///src/engines/registry.ts#L373-L375)). Excepție: `grok` are `mcp: "none"` ([L392](file:///src/engines/registry.ts#L392)) — poate publica prin CLI (`trb artifact publish ...`) sau scriind într-un folder convenit al sesiunii, iar contextul îl primește prin atașare/prompt.
- **Refolosire ca context între sesiuni:** butonul `Ask an agent` ([Detail.tsx](file:///web/src/features/artifacts/Detail.tsx#L86-L93)) + extensie în `attachAny` (`artifact:<id>`, mod `ref` cu cale locală sau `inline` pentru Markdown/rezumat) și `artifact_read` prin MCP pentru citire la cerere.
- **Cost / limite / mărime:** fără cost API extern și fără latența de 10–20s a `claude -p`. Necesită curățare/limită de versiuni pe disc (ca `MAX_ITEMS` în Evidence). **Mărime: M**.

### b) Funcțiile native ale fiecărui engine (citire din exterior)
- **Google Antigravity (`agy`):** pe acest sistem, aplicația salvează artefacte în `C:\Users\flori\.gemini\antigravity\brain\<conv-id>\` sub formă de Markdown (`implementation_plan.md`), capturi `.png` și fișiere `.metadata.json` (`artifactType`, `summary`, `updatedAt`, `requestFeedback`). Site-ul oficial descrie artefactele ca *"rich Markdown plans, task lists, code diffs, and auditable evidence"* (`https://antigravity.google`). Nu există însă un API oficial de export; citirea din `brain/` se bazează pe un format intern de disc, iar `agy` CLI rulează headless fără să expună aceste artefacte prin API.
- **OpenAI Codex / ChatGPT Canvas:** Codex CLI (`@openai/codex`) este un agent de terminal fără UI Canvas (`https://chatgpt.com/codex`); ChatGPT Canvas trăiește în aplicația web fără API REST public de export în timp real — doar copiere/descărcare manuală sau export complet `conversations.json` (`https://chatgpt.com`: *"No dedicated public REST API endpoint for pulling Canvas documents"*).
- **Cursor:** Plan Mode poate salva roadmap-uri Markdown în `.cursor/plans/*.plan.md` citibile din repo (`https://cursor.com`: *"Save to Workspace saves the roadmap as a Markdown file inside .cursor/plans/"*). **Cursor Canvases** (dashboard-uri/diagrame interactive în IDE) nu au API local de export — doar link-uri web read-only pe planuri plătite (`https://cursor.com`).
- **Gemini Canvas:** funcție exclusivă aplicației web Gemini; API-ul oficial (AI Studio / Vertex) nu expune un endpoint Canvas (`https://gemini.google.com`), existând doar export manual în Google Docs.
- **Grok:** Grok Studio există doar în web (`https://x.ai`); Grok Build CLI nu are tool nativ de Artifacts, iar în TreeBoss `grok` nu are MCP cablat ([src/engines/registry.ts](file:///src/engines/registry.ts#L392)).
- **Mărime:** **S** (doar import read-only pentru `.cursor/plans/` sau `antigravity/brain/`), dar acoperire fragmentată și fragilă.

### c) MCP Apps (`io.modelcontextprotocol/ui`)
- **Cum funcționează:** extensie oficială MCP (SEP-1865, `https://modelcontextprotocol.io`: *"allows MCP servers to deliver rich, interactive HTML user interfaces via ui:// resources with MIME type text/html;profile=mcp-app"*). Serverul expune resurse `ui://` legate de tool-uri prin `_meta.ui.resourceUri`, iar host-ul le randează în iframe sandboxed cu comunicare JSON-RPC peste `postMessage`.
- **Engine-uri / limite / mărime:** în TreeBoss, [src/mcp/serve.ts](file:///src/mcp/serve.ts#L86-L120) suportă doar `tools/list` și `tools/call` (fără `resources/read` și fără client MCP Apps în UI). Este util pentru widget-uri interactive de la servere MCP terțe, nu pentru documente/design-uri persistente între sesiuni. **Mărime: L**.

### d) Piese open-source de reutilizat
| Piesa | Rol | Licență | URL |
|---|---|---|---|
| `@modelcontextprotocol/ext-apps` | SDK oficial MCP Apps (`ui://` + `postMessage`) | Apache-2.0 | `https://github.com/modelcontextprotocol/ext-apps` |
| `mcp-ui` | Componente client/server pentru UI în iframe MCP | Apache-2.0 | `https://github.com/MCP-UI-Org/mcp-ui` |
| `reveal.js` | Prezentări/slide-uri HTML self-contained | MIT | `https://github.com/hakimel/reveal.js` |
| `Marp` (`@marp-team/marp`) | Conversie Markdown → slide-uri HTML | MIT | `https://github.com/marp-team/marp` |
| `Sandpack` | Sandbox multi-fișier React/JS în browser (opțional) | Apache-2.0 | `https://github.com/codesandbox/sandpack` |

---

## 3. Comparație

| Opțiune | Engine-uri acoperite | Persistă între sesiuni | Cost / dependențe externe | Mărime |
|---|---|---|---|---|
| **a) Store local TreeBoss + MCP** | Toate cu MCP (6/7); `grok` via CLI/fișier | Da (SQLite + `~/.treeboss/artifacts/`) | Zero cost extern | **M** |
| **b) Artefacte native per engine** | Doar Cursor Plans / Antigravity local | Parțial (formate interne) | Depinde de layout intern nestabil | **S** |
| **c) MCP Apps (`ui://`)** | Servere MCP cu UI (nu modelele direct) | Nu (epemer per tool call) | Necesită `resources/*` + bridge `postMessage` | **L** |

---

## 4. Recomandare și plan

**Recomandare:** **Opțiunea (a)** ca sistem principal, în 3 pași:
1. **Backend + MCP (`M`):** adăugarea `origin: "local" | "claude_ai"`, `engine`, `version` pe `artifacts`, plus tool-urile `artifact_publish`, `artifact_update`, `artifact_list` și extinderea `artifact_read` să accepte `id` local (nu doar URL `claude.ai`).
2. **UI + Context (`S`):** afișarea artefactelor locale în același tab `Artifacts` (refolosind `HTML_HEADERS`, `DocPreview`, `FilesPreview`), badge cu engine-ul sursă și integrare în `attachments` (`artifact:<id>`) pentru `@`-mențiune / `Ask an agent`.
3. **Opțional ulterior (`S`):** import read-only din `.cursor/plans/` și `~/.gemini/antigravity/brain/`, plus `Marp`/`reveal.js` pentru intent `slides`. `MCP Apps` rămâne separat, doar dacă se dorește randare de widget-uri MCP terțe.

**Ce rămâne Claude-only:** sincronizarea și citirea artefactelor găzduite pe `claude.ai` ([src/artifacts/reader.ts](file:///src/artifacts/reader.ts), `listAccount`, și `LiveView` pentru artefactele `shared`).

**Riscuri:**
- *Securitate XSS:* orice HTML generat de agenți trebuie servit strict cu `HTML_HEADERS` și `sandbox="allow-scripts"` (fără `allow-same-origin`).
- *Grok fără MCP:* până la suport MCP în `grok`, trebuie expus `trb artifact publish` (CLI) sau un folder de watch per sesiune.
- *Duplicare cu `docs/` și `design/`:* artefactele locale trebuie să rămână livrabile de sesiune (analize, prototipuri, slide-uri), nu să înlocuiască `DESIGN.md` sau documentația versiunată în git.

### Schiță data model (extensie `src/artifacts/types.ts` și `src/db.ts`)
```ts
export type ArtifactOrigin = "local" | "claude_ai";
// În Artifact + tabela `artifacts`:
// origin: ArtifactOrigin;        -- DEFAULT 'claude_ai' pentru rândurile existente
// engine: string | null;         -- 'claude' | 'codex' | 'cursor' | 'opencode' | 'agy' | 'devin' | 'grok'
// workspace: string | null;      -- workspaceKey(base_cwd), pentru filtrare per proiect
// version: number;               -- DEFAULT 1, incrementat la artifact_update
// url devine nullable (local artifacts nu au URL claude.ai, folosesc `trb://artifact/<id>`)
```

### Schiță tool schemas MCP (opțiunea a)
- `artifact_publish`: `{ title: string, intent: "document"|"slides"|"design"|"other", contentKind: "html"|"markdown"|"files", content?: string, files?: Record<string, string>, summary?: string }` → returnează `{ id, version: 1, path, uri: "trb://artifact/<id>" }`.
- `artifact_update`: `{ id: string, title?: string, content?: string, files?: Record<string, string>, summary?: string }` → salvează versiunea `v+1`, actualizează `updated_at` și `last_read_at`.
- `artifact_list`: `{ intent?: ArtifactIntent, query?: string, limit?: number }` → listează artefactele proiectului (locale + `claude.ai`) cu `id`, `title`, `intent`, `origin`, `engine`, `version`.
- `artifact_read`: `{ id?: string, url?: string, version?: number, prompt?: string }` → pentru `id` local citește direct de pe disc (zero cost); pentru `url` `claude.ai` păstrează fluxul actual.
