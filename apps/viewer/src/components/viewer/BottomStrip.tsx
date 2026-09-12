/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bottom strip: the docked bottom-region panel (Schedule / Script / Lists,
 * per `lib/panels/bottom-panels`) or a bottom-placed analysis extension, under
 * a drag-to-resize edge and a detach grip. Extracted from `ViewerLayout` so the
 * strip reads the panel table instead of a hand-written ternary per panel.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Grip } from 'lucide-react';
import { usePanelDetachDrag } from '@/hooks/usePanelDetachDrag';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import type { BottomPanelId } from '@/lib/panels/bottom-panels';
import { closeActiveAnalysisExtension, type AnalysisExtensionDefinition } from '@/services/analysis-extensions';

const BOTTOM_PANEL_MIN_HEIGHT = 120;
const BOTTOM_PANEL_DEFAULT_HEIGHT = 300;
const BOTTOM_PANEL_MAX_RATIO = 0.7; // max 70% of container

/** Slim grip atop a bottom-strip panel — drag to lift it into a floating window,
 *  or drag onto another screen to pop it out (#1208). */
function BottomPanelGrip({ id }: { id: BottomPanelId }) {
  const onPointerDown = usePanelDetachDrag(id);
  // Pointer-only drag affordance — not a real button (no keyboard action);
  // keyboard users dock / float via the sidebar rail / Alt+N (#1208).
  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to float · drag onto another screen to pop out"
      className="flex items-center justify-center h-5 shrink-0 cursor-grab active:cursor-grabbing select-none touch-none border-b border-border/40 bg-muted/10"
    >
      <Grip className="h-3.5 w-3.5 text-muted-foreground/50" />
    </div>
  );
}

export interface BottomStripProps {
  /** The bottom panel docked in the strip, or `null` when none is. */
  dockedPanel: BottomPanelId | null;
  /** A bottom-placed analysis extension owning the strip instead. */
  analysisExtension: AnalysisExtensionDefinition | null;
  /** The layout container the strip is resized against (its max height is a ratio of it). */
  containerRef: RefObject<HTMLDivElement | null>;
  closePanel: (id: BottomPanelId) => void;
}

export function BottomStrip({ dockedPanel, analysisExtension, containerRef, closePanel }: BottomStripProps) {
  // Pixel height, persisted in a ref during the drag to avoid re-renders per move.
  const [bottomHeight, setBottomHeight] = useState(BOTTOM_PANEL_DEFAULT_HEIGHT);
  const isDraggingRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Cleanup drag listeners on unmount
  useEffect(() => {
    return () => { cleanupRef.current?.(); };
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;

    const startY = e.clientY;
    const startHeight = bottomHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const container = containerRef.current;
      if (!container) return;

      const maxHeight = container.clientHeight * BOTTOM_PANEL_MAX_RATIO;
      const delta = startY - moveEvent.clientY;
      const newHeight = Math.min(
        maxHeight,
        Math.max(BOTTOM_PANEL_MIN_HEIGHT, startHeight + delta)
      );
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

    const onMouseUp = () => { cleanup(); };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    cleanupRef.current = cleanup;
  }, [bottomHeight, containerRef]);

  if (!dockedPanel && !analysisExtension) return null;

  return (
    <div data-detach-root style={{ height: bottomHeight, flexShrink: 0 }} className="relative">
      {/* Drag handle (resize height) */}
      <div
        className="absolute inset-x-0 top-0 h-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-row-resize z-10"
        onMouseDown={handleResizeStart}
      />
      <div className="h-full w-full overflow-hidden border-t pt-1.5 flex flex-col">
        {/* Detach grip — drag to float / pop the bottom panel onto another
            screen (hidden for analysis extensions, which own their chrome). */}
        {!analysisExtension && dockedPanel && <BottomPanelGrip id={dockedPanel} />}
        <div className="flex-1 min-h-0 overflow-hidden">
          {analysisExtension
            ? analysisExtension.renderPanel({ onClose: closeActiveAnalysisExtension })
            : dockedPanel && renderPanelBody(dockedPanel, () => closePanel(dockedPanel))}
        </div>
      </div>
    </div>
  );
}
