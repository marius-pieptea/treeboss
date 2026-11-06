import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { firstFamily, stripColors, tokenLabel, type TokenSummary } from "./logic";

/** A token value as a CSS background. Values that are themselves var() or unknown just render as given. */
const chip = (value: string): React.CSSProperties => ({ background: value });

/** A compact row of the main colors, light over dark, for cards and pickers. */
export function ColorStrip({ summary, className }: { summary: TokenSummary; className?: string }) {
  const colors = stripColors(summary);
  if (!colors.length) return <div className={cn("h-7 rounded-md border border-dashed border-line", className)} title="No color tokens" />;
  return (
    <div className={cn("flex h-7 overflow-hidden rounded-md border border-line", className)} aria-hidden>
      {colors.map((c) => (
        <div key={c.name} className="flex flex-1 flex-col" title={`${c.name}: ${c.light}${c.dark ? ` / ${c.dark}` : ""}`}>
          <span className="flex-1" style={chip(c.light)} />
          <span className="flex-1" style={chip(c.dark ?? c.light)} />
        </div>
      ))}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-muted">{children}</div>;
}

/** Every color, font and radius a tokens.css sets, with the contract names it is missing. */
export function TokenPanel({ summary, path }: { summary: TokenSummary; path: string }) {
  return (
    <div className="flex flex-col gap-4" data-design-tokens>
      <div>
        <Heading>
          Colors <span className="font-normal normal-case tracking-normal text-fg-faint">light · dark</span>
        </Heading>
        <ul className="flex flex-col gap-1">
          {summary.colors.map((c) => (
            <li key={c.name} className="flex items-center gap-2" title={c.name}>
              <span className="flex h-6 w-12 shrink-0 overflow-hidden rounded border border-line">
                <span className="flex-1" style={chip(c.light)} />
                <span className="flex-1" style={chip(c.dark ?? c.light)} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px]">{tokenLabel(c.name)}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-fg-faint">{c.light.length > 18 ? `${c.light.slice(0, 17)}…` : c.light}</span>
            </li>
          ))}
          {!summary.colors.length && <li className="text-[11.5px] text-fg-faint">No color tokens.</li>}
        </ul>
      </div>
      {summary.fonts.length > 0 && (
        <div>
          <Heading>Type</Heading>
          <ul className="flex flex-col gap-2">
            {summary.fonts.map((f) => (
              <li key={f.name} className="min-w-0">
                <div className="truncate text-[17px] leading-tight text-fg" style={{ fontFamily: f.value }}>
                  Aa — {firstFamily(f.value)}
                </div>
                <div className="truncate font-mono text-[10.5px] text-fg-faint">{f.name}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.radii.length > 0 && (
        <div>
          <Heading>Radius</Heading>
          <div className="flex flex-wrap gap-3">
            {summary.radii.map((r) => (
              <div key={r.name} className="flex flex-col items-center gap-1" title={`${r.name}: ${r.value}`}>
                <span className="size-9 border-2 border-accent/70 bg-accent-soft" style={{ borderRadius: r.value }} />
                <span className="font-mono text-[10px] text-fg-faint">{tokenLabel(r.name)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="font-mono text-[10.5px] text-fg-faint">
        {summary.count} tokens in {path}
      </div>
      {summary.missing.length > 0 && (
        <div className="flex gap-1.5 rounded-md border border-amber/40 bg-amber/5 p-2 text-[11px] text-fg-muted" data-design-missing>
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber" />
          <span>
            Missing {summary.missing.length} contract token{summary.missing.length === 1 ? "" : "s"}: <span className="font-mono text-[10.5px]">{summary.missing.slice(0, 8).join(", ")}{summary.missing.length > 8 ? ", …" : ""}</span>
          </span>
        </div>
      )}
    </div>
  );
}
