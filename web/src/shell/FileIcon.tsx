import { File, FileCode2, FileJson, FileText, Image, Settings, Terminal, Braces, Database, Lock, Package, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

/** A small, colour-coded icon per file kind. Colour carries meaning at a glance in a dense tree. */
export function FileIcon({ name, className }: { name: string; className?: string }) {
  const base = name.split("/").pop() ?? name;
  const lower = base.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  const c = cn("shrink-0", className);
  if (lower === "package.json" || lower === "bun.lock" || lower === "package-lock.json" || lower.endsWith(".lock")) return <Package className={cn(c, "text-green")} />;
  if (lower.startsWith(".git")) return <GitBranch className={cn(c, "text-red/80")} />;
  if (lower.startsWith(".env")) return <Lock className={cn(c, "text-amber")} />;
  if (lower === "dockerfile" || lower.startsWith("docker-compose")) return <Settings className={cn(c, "text-blue")} />;
  switch (ext) {
    case "ts":
    case "tsx":
      return <FileCode2 className={cn(c, "text-blue")} />;
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return <FileCode2 className={cn(c, "text-amber")} />;
    case "py":
      return <FileCode2 className={cn(c, "text-green")} />;
    case "rs":
    case "go":
    case "java":
    case "c":
    case "cpp":
    case "h":
    case "rb":
    case "php":
    case "swift":
    case "kt":
      return <FileCode2 className={cn(c, "text-violet")} />;
    case "json":
    case "jsonc":
      return <FileJson className={cn(c, "text-amber")} />;
    case "yml":
    case "yaml":
    case "toml":
    case "ini":
      return <Braces className={cn(c, "text-violet")} />;
    case "md":
    case "mdx":
    case "txt":
      return <FileText className={cn(c, "text-fg-muted")} />;
    case "css":
    case "scss":
    case "html":
    case "svg":
      return <FileCode2 className={cn(c, "text-accent")} />;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "ico":
    case "avif":
      return <Image className={cn(c, "text-violet")} />;
    case "sh":
    case "bash":
    case "zsh":
      return <Terminal className={cn(c, "text-green")} />;
    case "sql":
    case "sqlite":
    case "db":
      return <Database className={cn(c, "text-blue")} />;
    default:
      return <File className={cn(c, "text-fg-faint")} />;
  }
}
