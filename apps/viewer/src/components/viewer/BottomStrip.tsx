/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bottom strip: the docked bottom-region panel (Schedule / Script / Lists,
 * per `lib/panels/bottom-panels`) or a bottom-placed analysis extension, under
 * a drag-to-resize edge and a header (#5498: a tab row for the bottom panels
 * opened this session, the detach grip, maximize/restore, and Close).
 * Extracted from `ViewerLayout` so the strip reads the panel table instead of
 * a hand-written ternary per panel.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import { closeActiveAnalysisExtension, type AnalysisExtensionDefinition } from '@/services/analysis-extensions';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { BottomStripHeader } from './BottomStripHeader';
import {
  BOTTOM_STRIP_MIN_HEIGHT,
  BOTTOM_STRIP_DEFAULT_HEIGHT,
  BOTTOM_STRIP_MAX_RATIO,
  loadBottomStripHeight,
  persistBottomStripHeight,
  loadBottomStripTabs,
  persistBottomStripTabs,
  type BottomStripOrientation,
} from '@/lib/panels/bottom-strip-persistence';

export interface BottomStripProps {
  /** The bottom panel docked in the strip, or `null` when none is. */
  dockedPanel: BottomPanelId | null;
  /** A bottom-placed analysis extension owning the strip instead. */
  analysisExtension: AnalysisExtensionDefinition | null;
  /** The layout container the strip is resized against (its max height is a ratio of it). */
  containerRef: RefObject<HTMLDivElement | null>;
  closePanel: (id: BottomPanelId) => void;
  /** Which edge the strip docks to (#5515). Defaults to `'bottom'` — its own
   *  drag-to-resize edge and fixed height. `'side'` means `ViewerLayout` has
   *  already placed this instance inside a horizontal split beside the 3D
   *  view, so the strip fills its host `Panel` instead of sizing itself. */
  orientation?: BottomStripOrientation;
  /** Present only when the active panel can go side-by-side (Drawing). */
  onToggleOrientation?: () => void;
}

export function BottomStrip({ dockedPanel, analysisExtension, containerRef, closePanel, orientation = 'bottom', onToggleOrientation }: BottomStripProps) {
  const { openInHome } = usePanelControls();
  // Pixel height, persisted; kept in local state during the drag to avoid
  // writing to localStorage on every pointer move (#1208's rect debounce
  // does the same for floating panels, but a resize-end write is simpler here).
  const [bottomHeight, setBottomHeight] = useState(() => loadBottomStripHeight());
  const [tabs, setTabs] = useState<BottomPanelId[]>(() => loadBottomStripTabs());
  const [isMaximized, setIsMaximized] = useState(false);
  const isDraggingRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // "Reset layout" (#5854) restores the default height (and un-maximizes,
  // #5498). Only a reset made while the strip is mounted counts: the epoch
  // stays non-zero after the first reset, so comparing against 0 re-ran the
  // reset on every later mount and threw away the persisted height (#5957).
  const layoutResetEpoch = useViewerStore((s) => s.layoutResetEpoch);
  const mountEpochRef = useRef(layoutResetEpoch);
  useEffect(() => {
    if (layoutResetEpoch === mountEpochRef.current) return;
    setBottomHeight(BOTTOM_STRIP_DEFAULT_HEIGHT);
    setIsMaximized(false);
    persistBottomStripHeight(BOTTOM_STRIP_DEFAULT_HEIGHT);
  }, [layoutResetEpoch]);

  // Cleanup drag listeners on unmount
  useEffect(() => {
    return () => { cleanupRef.current?.(); };
  }, []);

  // A panel docked by any other path (sidebar rail, Alt+N, a tour) joins the
  // tab row too — the row is "every bottom panel opened", not just the ones
  // clicked from within it.
  useEffect(() => {
    if (!dockedPanel || tabs.includes(dockedPanel)) return;
    const next = [...tabs, dockedPanel];
    setTabs(next);
    persistBottomStripTabs(next);
  }, [dockedPanel, tabs]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;

    const startY = e.clientY;
    const startHeight = bottomHeight;
    let latestHeight = startHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const container = containerRef.current;
      if (!container) return;

      const maxHeight = container.clientHeight * BOTTOM_STRIP_MAX_RATIO;
      const delta = startY - moveEvent.clientY;
      const newHeight = Math.min(
        maxHeight,
        Math.max(BOTTOM_STRIP_MIN_HEIGHT, startHeight + delta)
      );
      latestHeight = newHeight;
      setBottomHeight(newHeight);
    };

    const cleanup = () => {
      isDraggingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      cleanupRef.current = null;
    };

    const onMouseUp = () => {
      cleanup();
      persistBottomStripHeight(latestHeight);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    cleanupRef.current = cleanup;
  }, [bottomHeight, containerRef]);

  // Switching tabs re-docks (undoing a float / pop-out) and flips the
  // exclusive flag — the same `openInHome` the sidebar rail / Alt+N use.
  const handleSelectTab = useCallback((id: BottomPanelId) => {
    if (id !== dockedPanel) openInHome(id);
  }, [dockedPanel, openInHome]);

  // Drops the tab from the row and fully closes that panel (its dock flag,
  // any float / OS window). If it was the active tab, a neighbour takes over
  // so closing one tab never blanks the strip while others remain open.
  const handleCloseTab = useCallback((id: BottomPanelId) => {
    const idx = tabs.indexOf(id);
    if (idx === -1) return;
    const wasActive = id === dockedPanel;
    const next = tabs.filter((t) => t !== id);
    setTabs(next);
    persistBottomStripTabs(next);
    closePanel(id);
    if (wasActive && next.length > 0) {
      openInHome(next[idx] ?? next[next.length - 1]);
    }
  }, [tabs, dockedPanel, closePanel, openInHome]);

  const handleToggleMaximize = useCallback(() => setIsMaximized((m) => !m), []);

  if (!dockedPanel && !analysisExtension) return null;

  // Side docking (#5515) is sized by the host `Panel`/resize-handle in
  // ViewerLayout, not by this component's own height + row-resize drag —
  // those are 'bottom'-only, same as the maximize overlay already was.
  const isSide = orientation === 'side' && !isMaximized;

  return (
    <div
      data-detach-root
      data-bottom-strip
      style={isMaximized || isSide ? undefined : { height: bottomHeight, flexShrink: 0 }}
      className={isMaximized ? 'absolute inset-0 z-20 bg-background' : isSide ? 'relative h-full w-full' : 'relative'}
    >
      {/* Drag handle (resize height) — 'bottom' only, and hidden while
          maximized: restore first. */}
      {!isMaximized && !isSide && (
        <div
          className="absolute inset-x-0 top-0 h-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-row-resize z-10"
          onMouseDown={handleResizeStart}
        />
      )}
      <div className={`h-full w-full overflow-hidden pt-1.5 flex flex-col ${isSide ? 'border-l' : 'border-t'}`}>
        {/* Hidden for analysis extensions, which own their chrome. */}
        {!analysisExtension && dockedPanel && (
          <BottomStripHeader
            tabs={tabs}
            activePanel={dockedPanel}
            onSelectTab={handleSelectTab}
            onCloseTab={handleCloseTab}
            isMaximized={isMaximized}
            onToggleMaximize={handleToggleMaximize}
            orientation={orientation}
            onToggleOrientation={onToggleOrientation}
          />
        )}
        <div
          className="flex-1 min-h-0 overflow-hidden"
          role={!analysisExtension && dockedPanel ? 'tabpanel' : undefined}
          id={!analysisExtension && dockedPanel ? `bottom-strip-panel-${dockedPanel}` : undefined}
          aria-labelledby={!analysisExtension && dockedPanel ? `bottom-strip-tab-${dockedPanel}` : undefined}
        >
          {analysisExtension
            ? analysisExtension.renderPanel({ onClose: closeActiveAnalysisExtension })
            : dockedPanel && renderPanelBody(dockedPanel, () => closePanel(dockedPanel))}
        </div>
      </div>
    </div>
  );
}
