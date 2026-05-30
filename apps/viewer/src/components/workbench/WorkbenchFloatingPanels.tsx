/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Dock, GripHorizontal, X } from 'lucide-react';
import type { FloatingPanelPlacement } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { getWorkbenchPanelTitle } from './panelRegistry';
import { WorkbenchPanelHost } from './WorkbenchPanelHost';

export function WorkbenchFloatingPanels() {
  const placements = useViewerStore((s) => s.workbenchLayout.floating);
  if (placements.length === 0) return null;
  return (
    <>
      {placements.map((placement) => (
        <FloatingPanelWindow key={placement.panelId} placement={placement} />
      ))}
    </>
  );
}

function FloatingPanelWindow({ placement }: { placement: FloatingPanelPlacement }) {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const setFloating = useViewerStore((s) => s.setWorkbenchFloatingPanel);
  const removeFloating = useViewerStore((s) => s.removeWorkbenchFloatingPanel);
  const movePanel = useViewerStore((s) => s.moveWorkbenchPanel);
  const setChrome = useViewerStore((s) => s.setWorkbenchPanelChrome);
  const title = getWorkbenchPanelTitle(layout, placement.panelId);
  const [dragging, setDragging] = useState(false);

  const startDrag = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    setDragging(true);
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = placement;
    const onMouseMove = (move: MouseEvent) => {
      setFloating({
        ...initial,
        x: Math.max(0, initial.x + move.clientX - startX),
        y: Math.max(48, initial.y + move.clientY - startY),
      });
    };
    const cleanup = () => {
      setDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', cleanup);
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', cleanup);
    document.body.style.userSelect = 'none';
  }, [placement, setFloating]);

  return (
    <div
      className={cn(
        'absolute z-40 flex flex-col overflow-hidden rounded-md border bg-background shadow-2xl',
        dragging && 'ring-2 ring-primary',
      )}
      style={{
        left: placement.x,
        top: placement.y,
        width: placement.width,
        height: placement.height,
      }}
      role="dialog"
      aria-label={`Floating panel ${title}`}
    >
      <div className="flex items-center gap-2 border-b bg-muted/50 px-2 py-1.5 text-xs">
        <button type="button" className="cursor-move text-muted-foreground" onMouseDown={startDrag} aria-label={`Move ${title}`}>
          <GripHorizontal className="h-4 w-4" />
        </button>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Dock floating panel"
          onClick={() => {
            removeFloating(placement.panelId);
            setChrome(placement.panelId, { hidden: false });
            movePanel(placement.panelId, 'right');
          }}
        >
          <Dock className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Close floating panel"
          onClick={() => removeFloating(placement.panelId)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <WorkbenchPanelHost panelId={placement.panelId} zone="right" />
      </div>
    </div>
  );
}
