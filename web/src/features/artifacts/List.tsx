import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, File, FileText, Layers, LayoutPanelLeft, Link, Presentation, RefreshCw, Search } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Badge, Empty, SegTabs, Skeleton } from "@/components/ui/misc";
import { useElementSize } from "@/lib/hooks";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";
import { takePendingFocusLink, type AccountStatus, type Artifact, type ArtifactIntent } from "./data";
import { AccountBanner } from "./ErrorPanel";
import {
  countByIntent,
  documentsTabLabel,
  filterArtifacts,
  formatRowMeta,
  groupArtifacts,
  matchesSearch,
  type GroupMode,
  type IntentFilter,
} from "./format";

function IntentIcon({ intent }: { intent: ArtifactIntent }) {
  const cls = "mt-1 size-3.5 shrink-0 text-fg-muted";
  switch (intent) {
    case "document":
      return <FileText className={cls} />;
    case "slides":
      return <Presentation className={cls} />;
    case "design":
      return <LayoutPanelLeft className={cls} />;
    default:
      return <File className={cls} />;
  }
}

const GROUP_OPTIONS = [
  { value: "session", label: "Group: Session" },
  { value: "date", label: "Group: Date" },
];

export function List({
  items,
  account,
  isLoading,
  loadError,
  selectedId,
  onSelect,
  onAdd,
  adding,
  onRefresh,
  refreshing,
  fallbackWidth,
  style,
  className,
}: {
  items: Artifact[];
  account: AccountStatus;
  isLoading: boolean;
  loadError: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (url: string) => Promise<void>;
  adding: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  fallbackWidth: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [panelRef, size] = useElementSize<HTMLDivElement>();
  const linkRef = useRef<HTMLInputElement>(null);
  const [linkValue, setLinkValue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [intent, setIntent] = useState<IntentFilter>("all");
  const groupMode = useUi((s) => s.artifactsGroup);
  const setGroupMode = useUi((s) => s.setArtifactsGroup);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (takePendingFocusLink()) linkRef.current?.focus();
    const onFocus = () => linkRef.current?.focus();
    window.addEventListener("trb:artifacts-focus-link", onFocus);
    return () => window.removeEventListener("trb:artifacts-focus-link", onFocus);
  }, []);

  const searchMatches = useMemo(() => items.filter((item) => matchesSearch(item, query)), [items, query]);
  const counts = useMemo(() => countByIntent(searchMatches), [searchMatches]);
  const filtered = useMemo(() => filterArtifacts(items, query, intent), [items, query, intent]);
  const groups = useMemo(() => groupArtifacts(filtered, groupMode), [filtered, groupMode]);

  const measuredWidth = size.width > 0 ? size.width : fallbackWidth;
  const docsLabel = documentsTabLabel(measuredWidth);
  const emptyList = items.length === 0;

  const submitLink = async () => {
    const trimmed = linkValue.trim();
    if (!trimmed || adding) return;
    setAddError(null);
    try {
      await onAdd(trimmed);
      setLinkValue("");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    }
  };

  const countBadge = (n: number) =>
    items.length > 0 ? <span className="font-mono text-label text-fg-muted">{n}</span> : undefined;

  return (
    <div ref={panelRef} style={style} className={cn("flex min-h-0 flex-col bg-panel", className)}>
      <div className="flex flex-col gap-2 border-b border-line p-3">
        {/* Row 1: header */}
        <div className="flex items-center gap-2">
          <Layers className="size-4 shrink-0 text-fg-muted" />
          <h1 className="text-lg font-semibold">Artifacts</h1>
          <span className="font-mono text-label text-fg-muted">{items.length}</span>
          <div className="flex-1" />
          <IconButton label="Refresh" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && "animate-spin-fast")} />
          </IconButton>
        </div>

        {/* Row 2: paste link + Add */}
        <div className="flex flex-col gap-1">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitLink();
            }}
            className="flex items-center gap-2"
          >
            <div className="relative min-w-0 flex-1">
              <Link className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
              <Input
                ref={linkRef}
                value={linkValue}
                onChange={(e) => {
                  setLinkValue(e.target.value);
                  if (addError) setAddError(null);
                }}
                placeholder="Paste a claude.ai artifact link"
                aria-label="Paste a claude.ai artifact link"
                aria-invalid={Boolean(addError)}
                className={cn("pl-8", addError && "border-red focus:border-red")}
              />
            </div>
            <Button
              type="submit"
              variant={linkValue.trim() ? "primary" : "subtle"}
              disabled={!linkValue.trim() || adding}
            >
              Add
            </Button>
          </form>
          {addError && <p className="text-xs text-red">{addError}</p>}
        </div>

        {/* Row 3: search + group select */}
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-faint" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, session, link"
              aria-label="Search artifacts"
              disabled={emptyList}
              className="h-7 pl-8 text-xs"
            />
          </div>
          <Select
            size="sm"
            value={groupMode}
            onChange={(v) => setGroupMode(v as GroupMode)}
            options={GROUP_OPTIONS}
            disabled={emptyList}
            aria-label="Group artifacts"
            className="w-auto shrink-0"
          />
        </div>

        {/* Row 4: intent filter */}
        <div className={cn(emptyList && "pointer-events-none opacity-50")}>
          <SegTabs
            value={intent}
            onChange={setIntent}
            items={[
              { value: "all", label: "All", badge: countBadge(counts.all) },
              { value: "document", label: docsLabel, badge: countBadge(counts.document) },
              { value: "slides", label: "Slides", badge: countBadge(counts.slides) },
              { value: "design", label: "Designs", badge: countBadge(counts.design) },
              { value: "other", label: "Other", badge: countBadge(counts.other) },
            ]}
          />
        </div>
      </div>

      <AccountBanner account={account} onRefresh={onRefresh} refreshing={refreshing} />

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="grid gap-2 p-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : loadError ? (
          <div className="p-3 text-xs text-red">{loadError}</div>
        ) : emptyList ? (
          <Empty
            icon={<Layers />}
            title="No artifacts yet"
            hint="When a Claude session publishes an artifact to your claude.ai account, it shows up here. You can also paste a link above."
            className="m-3 rounded-xl border border-dashed border-line"
          />
        ) : filtered.length === 0 ? (
          <Empty icon={<Layers />} title="Nothing matches" className="m-3" />
        ) : (
          <div className="flex flex-col">
            {groups.map((group) => {
              const isCollapsed = collapsed[group.key] ?? group.collapsedByDefault;
              return (
                <section key={group.key} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => setCollapsed((prev) => ({ ...prev, [group.key]: !isCollapsed }))}
                    aria-expanded={!isCollapsed}
                    className="flex h-7 shrink-0 items-center gap-1 px-3 text-left text-label font-medium uppercase tracking-label text-fg-muted outline-none hover:bg-hover hover:text-fg"
                  >
                    <ChevronRight className={cn("size-3 shrink-0 text-fg-faint transition-transform duration-150", !isCollapsed && "rotate-90")} />
                    <span className="min-w-0 truncate">{group.label}</span>
                    <span className="ml-auto font-mono text-label normal-case tracking-normal text-fg-muted">{group.items.length}</span>
                  </button>
                  {!isCollapsed && (
                    <ul className="flex flex-col">
                      {group.items.map((item) => {
                        const selected = item.id === selectedId;
                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => onSelect(item.id)}
                              className={cn(
                                "flex w-full items-start gap-2 border-b border-line px-3 py-2 text-left outline-none hover:bg-hover",
                                selected && "bg-accent-soft",
                              )}
                            >
                              <IntentIcon intent={item.intent} />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1">
                                  <span title={item.title} className="min-w-0 flex-1 truncate text-base font-medium text-fg">
                                    {item.title || item.url}
                                  </span>
                                  {item.owner === "shared" && <Badge tone="blue">shared</Badge>}
                                </span>
                                <span className="block truncate font-mono text-label text-fg-muted">
                                  {formatRowMeta(item, groupMode)}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
