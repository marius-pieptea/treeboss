import { Bot, Box, Database, Globe, Layers, Rocket, Server, Smartphone, SquareTerminal, Zap, type LucideIcon } from "lucide-react";

const MAP: Record<string, LucideIcon> = { box: Box, globe: Globe, server: Server, layers: Layers, smartphone: Smartphone, terminal: SquareTerminal, database: Database, rocket: Rocket, zap: Zap, bot: Bot };

/** The glyph for a template's icon key (unknown keys fall back to a box). */
export function RecipeIcon({ name, className }: { name?: string; className?: string }) {
  const I = MAP[name ?? ""] ?? Box;
  return <I className={className} />;
}
