/**
 * Language detection (pure) and lazy loading of CodeMirror language packs. Packs are dynamic imports so
 * opening a Rust file does not ship the Python grammar; the editor shows plain text until the pack arrives.
 */
import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";

export interface LangInfo {
  id: string;
  label: string;
}

const EXT: Record<string, LangInfo> = {
  ts: { id: "ts", label: "TypeScript" },
  mts: { id: "ts", label: "TypeScript" },
  cts: { id: "ts", label: "TypeScript" },
  tsx: { id: "tsx", label: "TypeScript React" },
  js: { id: "js", label: "JavaScript" },
  mjs: { id: "js", label: "JavaScript" },
  cjs: { id: "js", label: "JavaScript" },
  jsx: { id: "jsx", label: "JavaScript React" },
  json: { id: "json", label: "JSON" },
  jsonc: { id: "json", label: "JSON with Comments" },
  json5: { id: "json", label: "JSON5" },
  css: { id: "css", label: "CSS" },
  scss: { id: "css", label: "SCSS" },
  less: { id: "css", label: "Less" },
  html: { id: "html", label: "HTML" },
  htm: { id: "html", label: "HTML" },
  vue: { id: "html", label: "Vue" },
  svelte: { id: "html", label: "Svelte" },
  md: { id: "markdown", label: "Markdown" },
  mdx: { id: "markdown", label: "MDX" },
  markdown: { id: "markdown", label: "Markdown" },
  py: { id: "python", label: "Python" },
  pyi: { id: "python", label: "Python" },
  rs: { id: "rust", label: "Rust" },
  go: { id: "go", label: "Go" },
  sql: { id: "sql", label: "SQL" },
  yml: { id: "yaml", label: "YAML" },
  yaml: { id: "yaml", label: "YAML" },
  xml: { id: "xml", label: "XML" },
  svg: { id: "xml", label: "SVG" },
  plist: { id: "xml", label: "XML" },
  java: { id: "java", label: "Java" },
  c: { id: "cpp", label: "C" },
  h: { id: "cpp", label: "C Header" },
  cc: { id: "cpp", label: "C++" },
  cpp: { id: "cpp", label: "C++" },
  cxx: { id: "cpp", label: "C++" },
  hpp: { id: "cpp", label: "C++ Header" },
  php: { id: "php", label: "PHP" },
  sh: { id: "shell", label: "Shell" },
  bash: { id: "shell", label: "Shell" },
  zsh: { id: "shell", label: "Shell" },
  toml: { id: "toml", label: "TOML" },
  rb: { id: "ruby", label: "Ruby" },
  swift: { id: "swift", label: "Swift" },
  kt: { id: "kotlin", label: "Kotlin" },
  kts: { id: "kotlin", label: "Kotlin" },
  cs: { id: "csharp", label: "C#" },
  scala: { id: "scala", label: "Scala" },
  dart: { id: "dart", label: "Dart" },
  lua: { id: "lua", label: "Lua" },
  pl: { id: "perl", label: "Perl" },
  ini: { id: "properties", label: "INI" },
  properties: { id: "properties", label: "Properties" },
  env: { id: "properties", label: "Env" },
  diff: { id: "diff", label: "Diff" },
  patch: { id: "diff", label: "Diff" },
  conf: { id: "nginx", label: "Config" },
  ps1: { id: "powershell", label: "PowerShell" },
  txt: { id: "text", label: "Plain Text" },
  log: { id: "text", label: "Log" },
};

/** Files identified by their whole name rather than an extension. */
const NAME: Record<string, LangInfo> = {
  dockerfile: { id: "dockerfile", label: "Dockerfile" },
  containerfile: { id: "dockerfile", label: "Dockerfile" },
  makefile: { id: "shell", label: "Makefile" },
  ".bashrc": { id: "shell", label: "Shell" },
  ".zshrc": { id: "shell", label: "Shell" },
  ".profile": { id: "shell", label: "Shell" },
  ".gitignore": { id: "properties", label: "Ignore" },
  ".dockerignore": { id: "properties", label: "Ignore" },
  ".editorconfig": { id: "properties", label: "EditorConfig" },
  gemfile: { id: "ruby", label: "Ruby" },
  rakefile: { id: "ruby", label: "Ruby" },
  "package.json": { id: "json", label: "JSON" },
  "tsconfig.json": { id: "json", label: "JSON with Comments" },
};

const PLAIN: LangInfo = { id: "text", label: "Plain Text" };

export function detectLanguage(path: string): LangInfo {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (NAME[name]) return NAME[name];
  if (name.startsWith(".env")) return { id: "properties", label: "Env" };
  if (name.startsWith("dockerfile.")) return NAME.dockerfile;
  const dot = name.lastIndexOf(".");
  if (dot > 0) return EXT[name.slice(dot + 1)] ?? PLAIN;
  return PLAIN;
}

/** Kinds of file the editor shows something other than editable text for. */
export type MediaKind = "image" | "video" | "audio" | "pdf" | null;
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp"]);
const VIDEO = new Set(["mp4", "webm", "mov"]);
const AUDIO = new Set(["mp3", "wav", "ogg", "m4a"]);
export function mediaKind(path: string): MediaKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE.has(ext)) return "image";
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return null;
}

/** SVG and Markdown are text, but worth a rendered preview next to the source. */
export type PreviewKind = "markdown" | "svg" | null;
export function previewKind(path: string): PreviewKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ext === "svg") return "svg";
  return null;
}

const legacy = async <T,>(load: Promise<T>, pick: (m: T) => any): Promise<Extension> => StreamLanguage.define(pick(await load));

const LOADERS: Record<string, () => Promise<Extension>> = {
  ts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  js: async () => (await import("@codemirror/lang-javascript")).javascript(),
  jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  go: async () => (await import("@codemirror/lang-go")).go(),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  xml: async () => (await import("@codemirror/lang-xml")).xml(),
  java: async () => (await import("@codemirror/lang-java")).java(),
  cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
  php: async () => (await import("@codemirror/lang-php")).php(),
  shell: () => legacy(import("@codemirror/legacy-modes/mode/shell"), (m) => m.shell),
  toml: () => legacy(import("@codemirror/legacy-modes/mode/toml"), (m) => m.toml),
  dockerfile: () => legacy(import("@codemirror/legacy-modes/mode/dockerfile"), (m) => m.dockerFile),
  ruby: () => legacy(import("@codemirror/legacy-modes/mode/ruby"), (m) => m.ruby),
  swift: () => legacy(import("@codemirror/legacy-modes/mode/swift"), (m) => m.swift),
  kotlin: () => legacy(import("@codemirror/legacy-modes/mode/clike"), (m) => m.kotlin),
  csharp: () => legacy(import("@codemirror/legacy-modes/mode/clike"), (m) => m.csharp),
  scala: () => legacy(import("@codemirror/legacy-modes/mode/clike"), (m) => m.scala),
  dart: () => legacy(import("@codemirror/legacy-modes/mode/clike"), (m) => m.dart),
  lua: () => legacy(import("@codemirror/legacy-modes/mode/lua"), (m) => m.lua),
  perl: () => legacy(import("@codemirror/legacy-modes/mode/perl"), (m) => m.perl),
  properties: () => legacy(import("@codemirror/legacy-modes/mode/properties"), (m) => m.properties),
  diff: () => legacy(import("@codemirror/legacy-modes/mode/diff"), (m) => m.diff),
  nginx: () => legacy(import("@codemirror/legacy-modes/mode/nginx"), (m) => m.nginx),
  powershell: () => legacy(import("@codemirror/legacy-modes/mode/powershell"), (m) => m.powerShell),
};

const cache = new Map<string, Promise<Extension | null>>();

/** The grammar for a language id, or null for plain text / a pack that failed to load. Cached per id. */
export function loadLanguage(id: string): Promise<Extension | null> {
  const loader = LOADERS[id];
  if (!loader) return Promise.resolve(null);
  let p = cache.get(id);
  if (!p) {
    p = loader().catch(() => null);
    cache.set(id, p);
  }
  return p;
}
