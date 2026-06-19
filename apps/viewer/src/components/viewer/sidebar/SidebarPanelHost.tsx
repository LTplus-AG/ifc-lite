/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The docked sidebar's content pane (#1208).
 *
 * Renders the single active workspace panel. Each panel ships its own header
 * (title + close), so the sidebar adds only a slim **grab bar**: a dot-grid
 * grip you drag to detach + a chevron that collapses the pane to the rail.
 *
 * The drag is LIVE: on the first move the panel lifts straight out of the dock
 * into a floating window (#1201) positioned exactly where it was, then tracks
 * the cursor for the whole gesture (no disappear-until-drop). Release inside
 * the viewport → it stays floating where dropped; release past the window edge
 * (e.g. dragging onto another monitor) → it hands off to an OS / Picture-in-
 * Picture window. Pointer capture on <body> keeps the gesture alive after the
 * grab bar unmounts and while the cursor leaves the window.
 *
 * Render precedence preserves the pre-existing right-slot behavior:
 *   right-placed analysis extension → Add Element tool → active panel → Information.
 */

import { useSyncExternalStore } from 'react';
import { Grip, ChevronRight } from 'lucide-react';
import { useViewerStore } from '@/store';
import { type WorkspacePanelId } from '@/lib/panels/registry';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { usePanelControls } from '@/hooks/usePanelControls';
import { usePanelDetachDrag } from '@/hooks/usePanelDetachDrag';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ExtensionDockHost } from '@/components/extensions/ExtensionDockHost';
import { AddElementPanel } from '../AddElementPanel';
import {
  closeActiveAnalysisExtension,
  getAnalysisExtensionById,
  getAnalysisExtensionsSnapshot,
  subscribeAnalysisExtensions,
} from '@/services/analysis-extensions';

/** Slim grab bar: drag the grip to lift the panel into a live floating window
 *  (release past the window edge to pop out to another screen); the chevron
 *  collapses the pane to the rail. Title-less + close-less — the body owns those. */
function PanelChromeBar({ detachId }: { detachId: WorkspacePanelId }) {
  const setSidebarMode = useViewerStore((s) => s.setSidebarMode);
  const onPointerDown = usePanelDetachDrag(detachId);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Pointer-only drag affordance — not a button (it has no keyboard
            action and wraps the real collapse <button>). Keyboard users reach
            panels via the activity bar / Alt+N (#1208). */}
        <div
          onPointerDown={onPointerDown}
          className="flex items-center gap-1 h-6 shrink-0 px-1.5 border-b border-border/50 bg-muted/10 select-none touch-none cursor-grab active:cursor-grabbing"
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
      <TooltipContent side="bottom">Drag to float · drag onto another screen to pop out</TooltipContent>
    </Tooltip>
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
      <div data-detach-root className="h-full flex flex-col panel-container">
        {rightExtension.renderPanel({ onClose: closeActiveAnalysisExtension })}
      </div>
    );
  }
  if (activeTool === 'addElement') {
    return (
      <div data-detach-root className="h-full flex flex-col panel-container">
        <AddElementPanel onClose={() => setActiveTool('select')} />
      </div>
    );
  }

  // Information fallback (or empty when Information is detached).
  if (shown === null || shown === 'properties') {
    return (
      <div data-detach-root className="h-full flex flex-col panel-container">
        {shown === 'properties' && <PanelChromeBar detachId="properties" />}
        <div className="flex-1 min-h-0 overflow-hidden">
          {shown === 'properties' && renderPanelBody('properties', () => {})}
        </div>
        <ExtensionDockHost slot="dock.right" className="max-h-[40%] border-t" />
      </div>
    );
  }

  // A docked analysis panel — grab bar + the panel's own body.
  return (
    <div className="h-full flex flex-col panel-container">
      <PanelChromeBar detachId={shown} />
      <div className="flex-1 min-h-0 overflow-hidden">{renderPanelBody(shown, () => closePanel(shown))}</div>
    </div>
  );
}
