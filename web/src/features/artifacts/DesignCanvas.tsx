import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  boundsOf,
  fitView,
  hasBoardGeometry,
  visibleBoards,
  zoomAt,
  type PositionedBoard,
  type View,
} from "./canvas-math";
import { capabilityFileUrl, type ArtifactBoard, type CanvasNote } from "./format";

export interface DesignCanvasHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fitAll: () => void;
  zoomTo100: () => void;
  focusBoard: (path: string) => void;
}

const MAX_LIVE_IFRAMES = 16;
const ENTER_IFRAME_SCREEN_WIDTH = 160;
const EXIT_IFRAME_SCREEN_WIDTH = 120;
const ANIM_MS = 180;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

const BoardTile = memo(function BoardTile({
  board,
  base,
  isLive,
  isFocused,
  showTitle: _showTitle,
  interactive,
  onDoubleClick,
}: {
  board: PositionedBoard<ArtifactBoard>;
  base: string;
  isLive: boolean;
  isFocused: boolean;
  showTitle: boolean;
  interactive: boolean;
  onDoubleClick: (path: string) => void;
}) {
  return (
    <div
      data-board-path={board.path}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick(board.path);
      }}
      style={{
        left: board.x,
        top: board.y,
        width: board.w,
        height: board.h,
        ...(board.radius !== undefined ? { borderRadius: board.radius } : {}),
      }}
      className={cn(
        "pointer-events-auto absolute box-content overflow-hidden border bg-panel",
        board.radius === undefined && "rounded-lg",
        isFocused ? "border-fg outline-2 outline-fg outline-offset-1" : "border-line",
      )}
    >
      {isLive ? (
        <iframe
          title={board.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          src={capabilityFileUrl(base, board.path)}
          style={{ width: board.w, height: board.h }}
          className={cn(
            "block border-0 bg-panel",
            interactive ? "pointer-events-auto" : "pointer-events-none",
          )}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-raised p-6 text-center">
          <span className="text-xl font-medium text-fg-muted">{board.title}</span>
        </div>
      )}
    </div>
  );
});

export function DesignCanvas({
  ref,
  artifactKey,
  base,
  boards,
  notes,
  focusedPath,
  hidden = false,
  onFocusPathChange,
  onZoomChange,
}: {
  ref?: Ref<DesignCanvasHandle>;
  artifactKey: string;
  base: string;
  boards: ArtifactBoard[];
  notes: CanvasNote[];
  focusedPath: string | null;
  hidden?: boolean;
  onFocusPathChange: (path: string | null) => void;
  onZoomChange: (zoom: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const viewRef = useRef(view);
  viewRef.current = view;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const focusedRef = useRef(focusedPath);
  focusedRef.current = focusedPath;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  const fittedKeyRef = useRef<string | null>(null);
  const animRafRef = useRef<number | null>(null);
  const prevLiveRef = useRef<Set<string>>(new Set());
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const activePointerIdRef = useRef<number | null>(null);

  const positionedBoards = useMemo(() => boards.filter(hasBoardGeometry), [boards]);
  const allBounds = useMemo(() => boundsOf(positionedBoards, notes), [positionedBoards, notes]);
  const minZoom = useMemo(() => {
    if (!allBounds || size.width <= 0 || size.height <= 0) return 0.05;
    return Math.min(0.05, fitView(allBounds, size.width, size.height).zoom);
  }, [allBounds, size.width, size.height]);
  const minZoomRef = useRef(minZoom);
  minZoomRef.current = minZoom;

  const cancelAnimation = useCallback(() => {
    if (animRafRef.current !== null) {
      cancelAnimationFrame(animRafRef.current);
      animRafRef.current = null;
    }
  }, []);

  const commitView = useCallback(
    (next: View) => {
      viewRef.current = next;
      setView(next);
      onZoomChange(next.zoom);
    },
    [onZoomChange],
  );

  const animateTo = useCallback(
    (target: View) => {
      cancelAnimation();
      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        commitView(target);
        return;
      }
      const from = viewRef.current;
      const start = performance.now();
      const step = (now: number) => {
        const rawT = Math.min(1, (now - start) / ANIM_MS);
        const eased = 1 - Math.pow(1 - rawT, 3);
        const next: View = {
          x: from.x + (target.x - from.x) * eased,
          y: from.y + (target.y - from.y) * eased,
          zoom: from.zoom + (target.zoom - from.zoom) * eased,
        };
        commitView(next);
        if (rawT < 1) {
          animRafRef.current = requestAnimationFrame(step);
        } else {
          animRafRef.current = null;
        }
      };
      animRafRef.current = requestAnimationFrame(step);
    },
    [cancelAnimation, commitView],
  );

  useEffect(() => {
    return () => {
      cancelAnimation();
      dragCleanupRef.current?.();
    };
  }, [cancelAnimation]);

  // Reset live-set hysteresis on artifact change.
  useEffect(() => {
    prevLiveRef.current = new Set();
  }, [artifactKey]);

  // Measure viewport via ResizeObserver; ignore 0x0 while hidden and keep view on later resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const nextW = Math.round(entry.contentRect.width);
      const nextH = Math.round(entry.contentRect.height);
      if (nextW <= 0 || nextH <= 0) return;
      setSize((prev) => (prev.width === nextW && prev.height === nextH ? prev : { width: nextW, height: nextH }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Initial fit on mount / artifact change once viewport has non-zero size.
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return;
    if (fittedKeyRef.current === artifactKey) return;
    fittedKeyRef.current = artifactKey;
    cancelAnimation();
    commitView(fitView(allBounds, size.width, size.height));
  }, [artifactKey, size.width, size.height, allBounds, cancelAnimation, commitView]);

  const zoomBy = useCallback(
    (factor: number) => {
      const { width, height } = sizeRef.current;
      if (width <= 0 || height <= 0) return;
      animateTo(zoomAt(viewRef.current, width / 2, height / 2, factor, minZoomRef.current, 4));
    },
    [animateTo],
  );

  const fitAll = useCallback(() => {
    const { width, height } = sizeRef.current;
    if (width <= 0 || height <= 0) return;
    animateTo(fitView(allBounds, width, height));
  }, [allBounds, animateTo]);

  const zoomTo100 = useCallback(() => {
    const { width, height } = sizeRef.current;
    if (width <= 0 || height <= 0) return;
    const cur = viewRef.current;
    if (cur.zoom === 1) return;
    animateTo(zoomAt(cur, width / 2, height / 2, 1 / cur.zoom, minZoomRef.current, 4));
  }, [animateTo]);

  const focusBoard = useCallback(
    (path: string) => {
      const board = positionedBoards.find((b) => b.path === path);
      onFocusPathChange(path);
      if (!board) return;
      const { width, height } = sizeRef.current;
      if (width <= 0 || height <= 0) return;
      const boardBounds = {
        minX: board.x,
        minY: board.y,
        maxX: board.x + board.w,
        maxY: board.y + board.h,
        width: board.w,
        height: board.h,
      };
      animateTo(fitView(boardBounds, width, height, 48, 1));
    },
    [positionedBoards, onFocusPathChange, animateTo],
  );

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => zoomBy(1.25),
      zoomOut: () => zoomBy(0.8),
      fitAll,
      zoomTo100,
      focusBoard,
    }),
    [zoomBy, fitAll, zoomTo100, focusBoard],
  );

  // Native non-passive wheel listener: wheel = pan, Ctrl/Meta+wheel (or pinch) = zoom at cursor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimation();
      const cur = viewRef.current;
      const lineScale = e.deltaMode === 1 ? 16 : 1;
      const dx = e.deltaX * lineScale;
      const dy = e.deltaY * lineScale;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const factor = Math.exp(-dy * 0.002);
        commitView(zoomAt(cur, sx, sy, factor, minZoomRef.current, 4));
      } else {
        commitView({ ...cur, x: cur.x - dx, y: cur.y - dy });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [cancelAnimation, commitView]);

  // Space-to-pan (only when canvas or descendant is activeElement) and global Escape to unfocus.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hiddenRef.current) return;
      if (e.code === "Space" && !e.repeat && !isTypingTarget(e.target)) {
        const el = containerRef.current;
        if (el && (document.activeElement === el || el.contains(document.activeElement))) {
          setSpaceHeld(true);
        }
      } else if (e.key === "Escape" && focusedRef.current !== null && !isTypingTarget(e.target)) {
        const target = e.target as HTMLElement | null;
        if (target?.closest("[data-radix-popper-content-wrapper], [role='dialog']")) return;
        onFocusPathChange(null);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [onFocusPathChange]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || activePointerIdRef.current !== null) return;
    const el = containerRef.current;
    el?.focus({ preventScroll: true });

    const pointerId = e.pointerId;
    activePointerIdRef.current = pointerId;

    const startedOnBoard = Boolean((e.target as HTMLElement | null)?.closest("[data-board-path]"));
    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = startX;
    let lastY = startY;
    let moved = false;

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      activePointerIdRef.current = null;
      dragCleanupRef.current = null;
      setIsPanning(false);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        moved = true;
        cancelAnimation();
        setIsPanning(true);
      }
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      commitView({
        ...viewRef.current,
        x: viewRef.current.x + dx,
        y: viewRef.current.y + dy,
      });
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      if (!moved && !startedOnBoard && focusedRef.current !== null) {
        onFocusPathChange(null);
      }
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      if (focusedPath !== null) {
        e.preventDefault();
        onFocusPathChange(null);
      }
      return;
    }
    if (e.code === "Space" && !isTypingTarget(e.target)) {
      e.preventDefault();
      return;
    }
    if (focusedPath !== null || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomBy(1.25);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomBy(0.8);
    } else if (e.key === "0") {
      e.preventDefault();
      fitAll();
    } else if (e.key === "1") {
      e.preventDefault();
      zoomTo100();
    }
  };

  // Virtualize iframes with hysteresis and a 16-iframe cap; focusedPath is always kept live.
  const livePaths = useMemo(() => {
    const next = new Set<string>();
    const hasFocused = focusedPath !== null && positionedBoards.some((b) => b.path === focusedPath);
    if (hasFocused && focusedPath) next.add(focusedPath);
    if (size.width <= 0 || size.height <= 0) return next;

    const baseMargin = Math.max(size.width, size.height);
    const prevLive = prevLiveRef.current;
    const vcx = size.width / 2;
    const vcy = size.height / 2;
    const distSq = (b: PositionedBoard<ArtifactBoard>) => {
      const bx = (b.x + b.w / 2) * view.zoom + view.x;
      const by = (b.y + b.h / 2) * view.zoom + view.y;
      return (bx - vcx) ** 2 + (by - vcy) ** 2;
    };

    // 1. Keep already-live boards within 2-viewport margin and >= 120px wide.
    if (prevLive.size > 0 && next.size < MAX_LIVE_IFRAMES) {
      const staying = visibleBoards(positionedBoards, view, size.width, size.height, baseMargin * 2)
        .filter((b) => !next.has(b.path) && prevLive.has(b.path) && b.w * view.zoom >= EXIT_IFRAME_SCREEN_WIDTH)
        .sort((a, b) => distSq(a) - distSq(b));
      for (const b of staying) {
        if (next.size >= MAX_LIVE_IFRAMES) break;
        next.add(b.path);
      }
    }

    // 2. Admit new boards within 1-viewport margin and >= 160px wide.
    if (next.size < MAX_LIVE_IFRAMES) {
      const entering = visibleBoards(positionedBoards, view, size.width, size.height, baseMargin)
        .filter((b) => !next.has(b.path) && b.w * view.zoom >= ENTER_IFRAME_SCREEN_WIDTH)
        .sort((a, b) => distSq(a) - distSq(b));
      for (const b of entering) {
        if (next.size >= MAX_LIVE_IFRAMES) break;
        next.add(b.path);
      }
    }

    return next;
  }, [positionedBoards, view, size.width, size.height, focusedPath]);

  useEffect(() => {
    prevLiveRef.current = livePaths;
  }, [livePaths]);

  const showTitles = view.zoom >= 0.08;
  const labelBoards = useMemo(() => {
    if (!showTitles || size.width <= 0 || size.height <= 0) return [];
    return visibleBoards(positionedBoards, view, size.width, size.height, 200);
  }, [positionedBoards, view, size.width, size.height, showTitles]);

  const handleBoardDoubleClick = useCallback(
    (path: string) => {
      focusBoard(path);
    },
    [focusBoard],
  );

  const allowInteractiveFocused = !spaceHeld && !isPanning;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      aria-label="Design canvas"
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className={cn(
        "relative min-h-0 flex-1 touch-none overflow-hidden bg-bg outline-none select-none",
        isPanning ? "cursor-grabbing" : "cursor-grab",
        hidden && "hidden",
      )}
    >
      <div
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          transformOrigin: "0 0",
        }}
        className="pointer-events-none absolute top-0 left-0"
      >
        {notes.map((note) =>
          note.kind === "title1" ? (
            <div
              key={note.id}
              style={{ left: note.x, top: note.y, width: note.maxW ?? note.w }}
              className="pointer-events-none absolute text-2xl font-semibold leading-tight text-fg"
            >
              {note.text}
            </div>
          ) : (
            <div
              key={note.id}
              style={{ left: note.x, top: note.y, width: note.w ?? 240 }}
              className="pointer-events-none absolute whitespace-pre-wrap rounded-lg border border-line bg-raised p-3 text-xs leading-relaxed text-fg-muted"
            >
              {note.text}
            </div>
          ),
        )}

        {positionedBoards.map((board) => {
          const isFocused = board.path === focusedPath;
          return (
            <BoardTile
              key={board.path}
              board={board}
              base={base}
              isLive={livePaths.has(board.path)}
              isFocused={isFocused}
              showTitle={showTitles}
              interactive={isFocused && allowInteractiveFocused}
              onDoubleClick={handleBoardDoubleClick}
            />
          );
        })}
      </div>

      {labelBoards.length > 0 && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {labelBoards.map((board) => (
            <div
              key={board.path}
              style={{
                left: board.x * view.zoom + view.x,
                top: board.y * view.zoom + view.y,
                transform: "translateY(-100%)",
                maxWidth: Math.max(48, board.w * view.zoom),
              }}
              className={cn(
                "absolute truncate pb-1 text-label font-medium",
                board.path === focusedPath ? "text-fg" : "text-fg-muted",
              )}
            >
              {board.title}
            </div>
          ))}
        </div>
      )}

      {focusedPath !== null && (
        <div
          className="absolute top-3 left-3 z-10 rounded-lg border border-line bg-panel p-0.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Button variant="ghost" size="sm" onClick={() => onFocusPathChange(null)}>
            <X />
            Exit board
          </Button>
        </div>
      )}
    </div>
  );
}
