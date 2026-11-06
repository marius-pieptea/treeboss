import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { Dialog as D } from "radix-ui";
import { bus } from "@/lib/bus";
import { useCommandStore } from "@/lib/commands";
import { Kbd } from "@/components/ui/misc";

/** Cmd-K / Cmd-Shift-P: every action in the app, searchable. Features contribute through useRegisterCommands. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const sources = useCommandStore((s) => s.sources);
  useEffect(() => bus.on("open-command-palette", () => setOpen(true)), []);

  const groups = useMemo(() => {
    const all = Object.values(sources).flat().filter((c) => !c.when || c.when());
    const by = new Map<string, typeof all>();
    for (const c of all) by.set(c.group, [...(by.get(c.group) ?? []), c]);
    return [...by.entries()];
    // `when` closures read live state, so recompute each time the palette opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, open]);

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/45 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <D.Content aria-describedby={undefined} className="fixed left-1/2 top-[14%] z-50 w-[600px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-pop outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-2 duration-150">
          <D.Title className="sr-only">Command palette</D.Title>
          <Command loop>
            <Command.Input placeholder="Type a command…" className="h-11 w-full border-b border-line bg-transparent px-4 text-[14px] text-fg outline-none placeholder:text-fg-faint" />
            <Command.List className="max-h-[380px] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-xs text-fg-faint">No matching commands</Command.Empty>
              {groups.map(([group, cmds]) => (
                <Command.Group key={group} heading={group} className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-faint">
                  {cmds.map((c) => (
                    <Command.Item
                      key={c.id}
                      value={`${c.group} ${c.title} ${c.keywords ?? ""}`}
                      onSelect={() => {
                        setOpen(false);
                        // Let the dialog close first so focus returns before the action steals it.
                        setTimeout(() => void c.run(), 0);
                      }}
                      className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] data-[selected=true]:bg-active [&_svg]:size-4 [&_svg]:text-fg-muted"
                    >
                      {c.icon}
                      <span className="flex-1 truncate">{c.title}</span>
                      {c.shortcut && <Kbd>{c.shortcut}</Kbd>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
