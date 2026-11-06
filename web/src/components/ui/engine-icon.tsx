import { Bot, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import { modelFamily } from "@/lib/models-logic";

/**
 * Brand marks for the engines and the model families behind them, served from web/public/engines/*.svg.
 * Black-on-transparent marks are flipped in dark themes with `dark:invert` (an <img> cannot take currentColor).
 */
interface Mark {
  src: string;
  name: string;
  invertDark?: boolean;
}

const MARKS: Record<string, Mark> = {
  anthropic: { src: "/engines/claude.svg", name: "Anthropic" },
  openai: { src: "/engines/openai.svg", name: "OpenAI", invertDark: true },
  google: { src: "/engines/googlegemini.svg", name: "Google" },
  xai: { src: "/engines/grok.svg", name: "xAI", invertDark: true },
  cursor: { src: "/engines/cursor.svg", name: "Cursor", invertDark: true },
  opencode: { src: "/engines/opencode.svg", name: "OpenCode", invertDark: true },
};

const ENGINE_MARK: Record<string, keyof typeof MARKS> = {
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
  opencode: "opencode",
  agy: "google",
  grok: "xai",
};

function MarkImg({ mark, className }: { mark: Mark; className?: string }) {
  return <img src={mark.src} alt="" aria-hidden draggable={false} title={mark.name} className={cn("shrink-0 select-none", mark.invertDark && "dark:invert", className)} />;
}

/** The mark of an engine's provider. Engines without one (the scripted test engine, unknown ids) get a neutral glyph. */
export function EngineIcon({ engine, className = "size-4" }: { engine: string | null | undefined; className?: string }) {
  const key = engine ? ENGINE_MARK[engine] : undefined;
  if (!key) return engine === "fake" ? <Bot className={cn("shrink-0 text-fg-faint", className)} aria-hidden /> : <Cpu className={cn("shrink-0 text-fg-faint", className)} aria-hidden />;
  return <MarkImg mark={MARKS[key]} className={className} />;
}

/**
 * The mark of the family a model belongs to (Claude, GPT, Gemini, Grok, Cursor's own), falling back to its
 * engine's mark, then to a monogram so a long list still has something to scan by.
 */
export function ModelIcon({ model, engine, className = "size-4" }: { model: string | null | undefined; engine?: string | null; className?: string }) {
  const fam = modelFamily(model);
  if (fam) return <MarkImg mark={MARKS[fam]} className={className} />;
  if (engine && ENGINE_MARK[engine] && (!model || model === "default")) return <EngineIcon engine={engine} className={className} />;
  const provider = model?.includes("/") ? model.split("/")[0] : (model ?? "?");
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center rounded-[4px] bg-raised font-mono text-[8px] font-semibold uppercase leading-none text-fg-faint ring-1 ring-line", className)}>
      {provider.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?"}
    </span>
  );
}
