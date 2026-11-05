/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bottom strip's height (#5498, #8802 R3b). Two remembered heights:
 * the one every bottom panel shares (300 px by default, enough for a table
 * or a script), and the Drawing's own, which until the user resizes the
 * strip while the Drawing shows is half of the layout container
 * (`drawingDefaultStripHeight`), so a docked section opens with room to be
 * read instead of in a 140 px band. The container's height is observed while
 * the Drawing shows, so that default follows a window resize until the user
 * picks a height, and a remembered height never exceeds the 0.7 resize cap
 * of the container it reopens in.
 */

import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import {
  BOTTOM_STRIP_DEFAULT_HEIGHT,
  capDrawingStripHeight,
  drawingDefaultStripHeight,
  loadBottomStripDrawingHeight,
  loadBottomStripHeight,
  persistBottomStripDrawingHeight,
  persistBottomStripHeight,
} from '@/lib/panels/bottom-strip-persistence';

function useContainerHeight(containerRef: RefObject<HTMLDivElement | null>, enabled: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!enabled || !el) return;
    setHeight(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef, enabled]);
  return height;
}

export interface BottomStripHeight {
  /** The height the strip shows at now, for the docked panel. */
  height: number;
  /** Live height while dragging (not persisted). */
  setHeight: (height: number) => void;
  /** Persist the height a drag ended at, for the docked panel. */
  commitHeight: (height: number) => void;
  /** "Reset layout": both heights back to their defaults. */
  resetHeights: () => void;
}

export function useBottomStripHeight(
  dockedPanel: BottomPanelId | null,
  containerRef: RefObject<HTMLDivElement | null>,
): BottomStripHeight {
  const isDrawing = dockedPanel === 'drawing';
  const [sharedHeight, setSharedHeight] = useState(() => loadBottomStripHeight());
  const [drawingHeight, setDrawingHeight] = useState<number | null>(() => loadBottomStripDrawingHeight());
  const containerHeight = useContainerHeight(containerRef, isDrawing);

  const height = !isDrawing ? sharedHeight
    : drawingHeight !== null ? capDrawingStripHeight(drawingHeight, containerHeight)
      : containerHeight > 0 ? drawingDefaultStripHeight(containerHeight) : sharedHeight;

  const setHeight = useCallback((next: number) => {
    if (isDrawing) setDrawingHeight(next);
    else setSharedHeight(next);
  }, [isDrawing]);

  const commitHeight = useCallback((next: number) => {
    if (isDrawing) persistBottomStripDrawingHeight(next);
    else persistBottomStripHeight(next);
  }, [isDrawing]);

  const resetHeights = useCallback(() => {
    setSharedHeight(BOTTOM_STRIP_DEFAULT_HEIGHT);
    setDrawingHeight(null);
    persistBottomStripHeight(BOTTOM_STRIP_DEFAULT_HEIGHT);
    persistBottomStripDrawingHeight(null);
  }, []);

  return { height, setHeight, commitHeight, resetHeights };
}
