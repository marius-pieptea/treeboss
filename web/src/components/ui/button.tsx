import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Tooltip } from "./overlay";

const button = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none transition-[background,color,transform,box-shadow,border-color] duration-100 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Disabled primary is its own flat state, not a faded copy: fading a coloured button washes the label out to nothing.
        primary: "bg-accent text-accent-fg shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_60%,black),0_1px_8px_-2px_color-mix(in_oklab,var(--accent)_55%,transparent)] hover:brightness-110 disabled:bg-active disabled:text-fg-faint disabled:opacity-100 disabled:shadow-none",
        outline: "border border-line-strong bg-transparent text-fg hover:bg-hover",
        ghost: "text-fg-muted hover:bg-hover hover:text-fg",
        subtle: "bg-raised text-fg hover:bg-active",
        danger: "bg-red/90 text-white hover:bg-red",
        dangerGhost: "text-red hover:bg-red/10",
      },
      size: {
        xs: "h-6 px-2 text-[11px] [&_svg]:size-3",
        sm: "h-7 px-2.5 text-xs [&_svg]:size-3.5",
        md: "h-8 px-3 text-[13px] [&_svg]:size-4",
        icon: "size-7 [&_svg]:size-4",
        "icon-sm": "size-6 [&_svg]:size-3.5",
        "icon-xs": "size-5 rounded [&_svg]:size-3",
      },
    },
    defaultVariants: { variant: "subtle", size: "sm" },
  },
);

export interface ButtonProps extends React.ComponentProps<"button">, VariantProps<typeof button> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(button({ variant, size }), className)} {...props} />;
}

/** An icon-only button that always explains itself on hover. */
export function IconButton({ label, shortcut, side = "bottom", className, variant = "ghost", size = "icon", ...props }: ButtonProps & { label: string; shortcut?: string; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={side}>
      <button aria-label={label} className={cn(button({ variant, size }), className)} {...props} />
    </Tooltip>
  );
}
