import * as React from "react";
import { cn } from "@/lib/utils";

/** An anchor that looks like the kit's Button (the kit's Button has no asChild). */
export function LinkButton({ variant = "outline", className, ...props }: React.ComponentProps<"a"> & { variant?: "outline" | "primary" }) {
  return (
    <a
      className={cn(
        "inline-flex h-7 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium outline-none transition-[background,transform] duration-100 active:scale-[0.97] [&_svg]:size-3.5",
        variant === "primary" ? "bg-accent text-accent-fg hover:brightness-110" : "border border-line-strong text-fg hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
}
