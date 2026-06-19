/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The docked sidebar's content pane (#1208).
 *
 * Renders the single active workspace panel. Each panel ships its own header
 * (title + close), so the sidebar adds only a slim **grab bar**: a dot-grid
 * grip you drag to detach the panel — release inside to float it (#1201),
 * release past the window edge to pop it onto another screen (#1208) — plus a
 * chevron that collapses the pane to the rail. (Keyboard-accessible
 * Float / Pop-out live in the activity-bar ⋯ menu, since drag is mouse-only.)
 *
 * Render precedence preserves the pre-existing right-slot behavior:
 *   right-placed analysis extension → Add Element tool → active panel → Information.
 * A panel that is floating (#1201) or popped out (#1208) is skipped here so it
 * isn't rendered twice.
 */

import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Grip, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { type WorkspacePanelId } from '@/lib/panels/registry';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { usePanelControls } from '@/hooks/usePanelControls';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ExtensionDockHost } from '@/components/extensions/ExtensionDockHost';
import { AddElementPanel } from '../AddElementPanel';
import {
  closeActiveAnalysisExtension,
  getAnalysisExtensionById,
  getAnalysisExtensionsSnapshot,
  subscribeAnalysisExtensions,
} from '@/services/analysis-extensions';
import { useSyncExternalStore } from 'react';

const DRAG_THRESHOLD = 6;

function isPointerOutsideWindow(x: number, y: number): boolean {
  return x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;
}

/**
 * Slim grab bar: drag the grip to detach (float, or pop out past the edge);
 * chevron collapses the pane to the rail. Intentionally title-less + close-less
 * — the panel body owns those.
 */
function PanelChromeBar({ detachId }: { detachId: WorkspacePanelId }) {
  const { floatPanel, popOutPanel } = usePanelControls();
  const setSidebarMode = useViewerStore((s) => s.setSidebarMode);
  const [drag, setDrag] = useState<{ active: boolean; outside: boolean }>({ active: false, outside: false });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-chrome-btn]')) return; // the chevron
    e.preventDefault();
    const node = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    try { node.setPointerCapture(e.pointerId); } catch { /* noop */ }

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESHOLD) {
        moved = true;
        setDrag({ active: true, outside: isPointerOutsideWindow(ev.clientX, ev.clientY) });
      } else if (moved) {
        setDrag({ active: true, outside: isPointerOutsideWindow(ev.clientX, ev.clientY) });
      }
    };
    const onUp = (ev: PointerEvent) => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      setDrag({ active: false, outside: false });
      if (!moved) return;
      if (isPointerOutsideWindow(ev.clientX, ev.clientY)) {
        popOutPanel(detachId); // dragged onto another screen → OS / PiP window
      } else {
        floatPanel(detachId); // released inside → in-app floating window
        const x = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - 40));
        const y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - 10));
        useViewerStore.getState().setFloatingPanelRect(detachId, { x, y });
      }
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onUp);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            onPointerDown={onPointerDown}
            role="button"
            aria-label="Drag to detach this panel"
            className={cn(
              'flex items-center gap-1 h-6 shrink-0 px-1.5 border-b border-border/50 bg-muted/10 select-none touch-none cursor-grab active:cursor-grabbing',
              drag.active && 'bg-primary/10',
            )}
          >
            <Grip className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            <span className="flex-1" />
            <button
              type="button"
              data-chrome-btn
              aria-label="Collapse sidebar to icons"
              title="Collapse to icons"
              onClick={() => setSidebarMode('collapsed')}
              className="h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Drag to float · drag onto another screen to pop out
        </TooltipContent>
      </Tooltip>
      {drag.active && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center pt-10">
          <div className="rounded-md border border-primary/40 bg-background/90 px-3 py-1.5 text-[11px] font-medium text-foreground shadow-lg">
            {drag.outside ? 'Release to open on another screen' : 'Release to float · drag past the edge for another screen'}
          </div>
        </div>
      )}
    </>
  );
}

export function SidebarPanelHost() {
  const activePanel = useViewerStore((s) => s.sidebarActivePanel);
  const activeTool = useViewerStore((s) => s.activeTool);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const { floatingIds, poppedIds, closePanel } = usePanelControls();

  const analysisState = useSyncExternalStore(
    subscribeAnalysisExtensions,
    getAnalysisExtensionsSnapshot,
    getAnalysisExtensionsSnapshot,
  );
  const activeAnalysisExtension = getAnalysisExtensionById(analysisState.activeId);
  const rightExtension = (activeAnalysisExtension?.placement ?? 'right') === 'right'
    ? activeAnalysisExtension
    : null;

  let shown: WorkspacePanelId | null = activePanel;
  if (floatingIds.has(shown) || poppedIds.has(shown)) shown = 'properties';
  if (shown === 'properties' && (floatingIds.has('properties') || poppedIds.has('properties'))) {
    shown = null;
  }

  // Right-placed analysis extension / Add Element carry their own chrome.
  if (rightExtension) {
    return (
      <div className="h-full flex flex-col panel-container">
        {rightExtension.renderPanel({ onClose: closeActiveAnalysisExtension })}
      </div>
    );
  }
  if (activeTool === 'addElement') {
    return (
      <div className="h-full flex flex-col panel-container">
        <AddElementPanel onClose={() => setActiveTool('select')} />
      </div>
    );
  }

  // Information fallback (or empty when Information is detached).
  if (shown === null || shown === 'properties') {
    return (
      <div className="relative h-full flex flex-col panel-container">
        {shown === 'properties' && <PanelChromeBar detachId="properties" />}
        <div className="flex-1 min-h-0 overflow-hidden">
          {shown === 'properties' && renderPanelBody('properties', () => {})}
        </div>
        <ExtensionDockHost slot="dock.right" className="max-h-[40%] border-t" />
      </div>
    );
  }

  // A docked analysis / tool panel — grab bar + the panel's own body.
  return (
    <div className="relative h-full flex flex-col panel-container">
      <PanelChromeBar detachId={shown} />
      <div className="flex-1 min-h-0 overflow-hidden">{renderPanelBody(shown, () => closePanel(shown))}</div>
    </div>
  );
}
