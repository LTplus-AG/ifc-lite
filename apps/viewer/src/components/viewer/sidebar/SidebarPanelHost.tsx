/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The docked sidebar's content pane (#1208).
 *
 * Renders the single active workspace panel. Each panel already ships its own
 * header (title + close), so the sidebar adds only a slim, title-less
 * "detach controls" strip (float / pop-out / collapse) above panels that can
 * detach — no duplicate titles or close buttons. The render precedence
 * preserves the pre-existing right-slot behavior:
 *   right-placed analysis extension → Add Element tool → active panel → Information.
 * A panel that is currently floating (#1201) or popped out (#1208) is skipped
 * here so it isn't rendered twice.
 */

import { useSyncExternalStore } from 'react';
import { PanelRightClose, SquareArrowOutUpRight, MonitorUp } from 'lucide-react';
import { useViewerStore } from '@/store';
import type { WorkspacePanelId } from '@/lib/panels/registry';
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

function ChromeButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={title}
          onClick={onClick}
          className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Slim detach-controls strip. Intentionally title-less + close-less: the panel
 * body owns its own title bar and close button, so this only adds the new
 * sidebar affordances (collapse-to-icons, float, pop-out). Rendered only for
 * panels that can detach.
 */
function DetachStrip({ detachId }: { detachId: WorkspacePanelId }) {
  const { floatPanel, popOutPanel } = usePanelControls();
  const setSidebarMode = useViewerStore((s) => s.setSidebarMode);
  return (
    <div className="flex items-center justify-end gap-0.5 h-7 shrink-0 px-1.5 border-b border-border/60 bg-muted/20 select-none">
      <ChromeButton title="Float as movable window" onClick={() => floatPanel(detachId)}>
        <SquareArrowOutUpRight className="h-3.5 w-3.5" />
      </ChromeButton>
      <ChromeButton title="Pop out to another screen" onClick={() => popOutPanel(detachId)}>
        <MonitorUp className="h-3.5 w-3.5" />
      </ChromeButton>
      <ChromeButton title="Collapse sidebar to icons" onClick={() => setSidebarMode('collapsed')}>
        <PanelRightClose className="h-3.5 w-3.5" />
      </ChromeButton>
    </div>
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

  // A detached panel doesn't render in the dock — fall back to Information,
  // or to an empty slot if Information itself is detached.
  let shown: WorkspacePanelId | null = activePanel;
  if (floatingIds.has(shown) || poppedIds.has(shown)) shown = 'properties';
  if (shown === 'properties' && (floatingIds.has('properties') || poppedIds.has('properties'))) {
    shown = null;
  }

  // ── Highest precedence: a right-placed analysis extension owns the slot.
  // Extensions carry their own chrome, so no detach strip. ──
  if (rightExtension) {
    return (
      <div className="h-full flex flex-col panel-container">
        {rightExtension.renderPanel({ onClose: closeActiveAnalysisExtension })}
      </div>
    );
  }

  // ── Then the Add Element authoring tool (own chrome). ──
  if (activeTool === 'addElement') {
    return (
      <div className="h-full flex flex-col panel-container">
        <AddElementPanel onClose={() => setActiveTool('select')} />
      </div>
    );
  }

  // ── Information fallback (or empty when Information is detached). ──
  if (shown === null || shown === 'properties') {
    return (
      <div className="h-full flex flex-col panel-container">
        {shown === 'properties' && <DetachStrip detachId="properties" />}
        <div className="flex-1 min-h-0 overflow-hidden">
          {shown === 'properties' && renderPanelBody('properties', () => {})}
        </div>
        <ExtensionDockHost slot="dock.right" className="max-h-[40%] border-t" />
      </div>
    );
  }

  // ── A docked analysis / tool panel — slim detach strip + the panel's own body. ──
  return (
    <div className="h-full flex flex-col panel-container">
      <DetachStrip detachId={shown} />
      <div className="flex-1 min-h-0 overflow-hidden">{renderPanelBody(shown, () => closePanel(shown))}</div>
    </div>
  );
}
