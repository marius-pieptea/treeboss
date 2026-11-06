import * as React from "react";
import { Dialog as D, DropdownMenu as DM, ContextMenu as CM, Popover as P, Tooltip as T } from "radix-ui";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- Tooltip */

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <T.Provider delayDuration={350} skipDelayDuration={120}>
      {children}
    </T.Provider>
  );
}

export function Tooltip({ label, shortcut, side = "bottom", panel = false, children }: { label: React.ReactNode; shortcut?: string; side?: "top" | "bottom" | "left" | "right"; /** A card, not a one-line hint. */ panel?: boolean; children: React.ReactElement }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className={cn("z-[100] rounded-md border border-line-strong bg-overlay text-fg shadow-pop animate-in fade-in-0 zoom-in-95 duration-100", panel ? "block p-2 text-left" : "flex items-center gap-2 px-2 py-1 text-[11px]")}>
          {label}
          {shortcut && <kbd className="rounded bg-raised px-1 py-px text-[10px] text-fg-muted">{shortcut}</kbd>}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

/* ----------------------------------------------------------------- Dialog */

export function Dialog({ open, onOpenChange, title, description, children, width = 440, footer }: { open: boolean; onOpenChange: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; width?: number; footer?: React.ReactNode }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <D.Content
          style={{ width }}
          className="fixed left-1/2 top-[18%] z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-line-strong bg-overlay shadow-pop outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-150"
        >
          <div className={cn("px-4 pt-4", !children && "pb-3")}>
            <D.Title className="text-[14px] font-semibold text-fg">{title}</D.Title>
            {description ? <D.Description className="mt-1 text-xs leading-relaxed text-fg-muted">{description}</D.Description> : <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>}
          </div>
          {children && <div className="px-4 py-3">{children}</div>}
          {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/* ------------------------------------------------------------------- Menu */

const menuContent = "pop-surface z-[90] min-w-[11rem] overflow-hidden rounded-xl border border-line-strong p-1 text-[12.5px] text-fg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-100";
const menuItem = "pop-row relative flex cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-active [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-muted";

export interface MenuEntry {
  label?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  /** Trailing content, e.g. a status chip. */
  badge?: React.ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  children?: MenuEntry[];
}

function renderItems(entries: MenuEntry[], K: typeof DM | typeof CM): React.ReactNode {
  return entries.map((e, i) => {
    if (e.separator) return <K.Separator key={i} className="my-1 h-px bg-line" />;
    if (e.children) {
      return (
        <K.Sub key={i}>
          <K.SubTrigger className={menuItem}>
            {e.icon}
            <span className="flex-1">{e.label}</span>
            <ChevronRight className="!size-3" />
          </K.SubTrigger>
          <K.Portal>
            <K.SubContent className={menuContent} sideOffset={4}>
              {renderItems(e.children, K)}
            </K.SubContent>
          </K.Portal>
        </K.Sub>
      );
    }
    return (
      <K.Item key={i} disabled={e.disabled} onSelect={() => e.onSelect?.()} className={cn(menuItem, e.danger && "text-red data-[highlighted]:bg-red/10 [&_svg]:!text-red")}>
        {e.checked !== undefined ? <Check className={cn("!size-3", e.checked ? "pop-check" : "opacity-0")} /> : e.icon}
        <span className="flex-1 truncate">{e.label}</span>
        {e.badge}
        {e.shortcut && <span className="ml-4 text-[10.5px] text-fg-faint">{e.shortcut}</span>}
      </K.Item>
    );
  });
}

/** `entries` scroll when there are many; `footer` stays pinned below them. */
export function DropdownMenu({ trigger, entries, footer, align = "start", side = "bottom" }: { trigger: React.ReactElement; entries: MenuEntry[]; footer?: MenuEntry[]; align?: "start" | "end" | "center"; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <DM.Root>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} side={side} sideOffset={5} collisionPadding={8} className={cn(menuContent, "flex max-h-[var(--radix-dropdown-menu-content-available-height)] flex-col")}>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{renderItems(entries, DM)}</div>
          {footer?.length ? (
            <>
              <DM.Separator className="my-1 h-px shrink-0 bg-line" />
              <div className="shrink-0">{renderItems(footer, DM)}</div>
            </>
          ) : null}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function ContextMenu({ entries, children, disabled }: { entries: MenuEntry[]; children: React.ReactElement; disabled?: boolean }) {
  if (disabled || entries.length === 0) return children;
  return (
    <CM.Root>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className={menuContent}>{renderItems(entries, CM)}</CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

/* ---------------------------------------------------------------- Popover */

export function Popover({ trigger, children, align = "start", side = "bottom", width, open, onOpenChange }: { trigger: React.ReactElement; children: React.ReactNode; align?: "start" | "end" | "center"; side?: "top" | "bottom" | "left" | "right"; width?: number; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content align={align} side={side} sideOffset={6} style={{ width }} className="pop-surface z-[90] rounded-xl border border-line-strong p-1.5 text-fg outline-none">
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
