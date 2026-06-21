/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The docked sidebar's content pane (#1208, split added in #1266).
 *
 * Renders the active workspace panel, and, when the user splits it, a SECOND
 * panel stacked beneath it with a draggable divider (Blender-style). Both halves
 * reserve real layout space (the pane is a flex sibling of the viewport), so a
 * split is "model | Information / IDS", never an overlay. Floating (#1201) stays
 * a separate overlay channel.
 *
 * Each panel ships its own header (title + close), so the sidebar adds only a
 * slim grab bar on top: a dot-grid grip you drag to detach, a Split control, and
 * a chevron that collapses the pane to the rail. The two stacked panels read as
 * a matched pair joined by one resize handle (which also carries the
 * remove-split action), so neither half repeats a title.
 *
 * The detach drag is LIVE: on the first move the panel lifts straight out of the
 * dock into a floating window (#1201) positioned exactly where it was, then
 * tracks the cursor for the whole gesture. Release inside the viewport keeps it
 * floating; release past the window edge hands it off to an OS / PiP window.
 *
 * Render precedence preserves the pre-existing right-slot behavior:
 *   right-placed analysis extension, then Add Element tool, then active panel,
 *   then Information.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { Grip, ChevronRight, Rows2, X, Check, GripHorizontal } from 'lucide-react';
import { useViewerStore } from '@/store';
import { WORKSPACE_PANELS, getPanelDef, type WorkspacePanelId } from '@/lib/panels/registry';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { usePanelControls } from '@/hooks/usePanelControls';
import { usePanelDetachDrag } from '@/hooks/usePanelDetachDrag';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ExtensionDockHost } from '@/components/extensions/ExtensionDockHost';
import { AddElementPanel } from '../AddElementPanel';
import {
  closeActiveAnalysisExtension,
  getAnalysisExtensionById,
  getAnalysisExtensionsSnapshot,
  subscribeAnalysisExtensions,
} from '@/services/analysis-extensions';

/** Right-pane panels eligible to share the docked split (#1266). */
const SIDE_PANELS = WORKSPACE_PANELS.filter((p) => p.region === 'side');

/** Dropdown that picks / switches / removes the lower split panel (#1266). */
function SplitMenu({ primaryId }: { primaryId: WorkspacePanelId }) {
  const secondary = useViewerStore((s) => s.sidebarSecondaryPanel);
  const setSecondary = useViewerStore((s) => s.setSidebarSecondaryPanel);
  const closeFloatingPanel = useViewerStore((s) => s.closeFloatingPanel);
  const setPanelPoppedOut = useViewerStore((s) => s.setPanelPoppedOut);

  // Picking a panel that's currently floating / popped pulls it back inline.
  const pick = (id: WorkspacePanelId) => {
    closeFloatingPanel(id);
    setPanelPoppedOut(id, false);
    setSecondary(id);
  };

  const options = SIDE_PANELS.filter((p) => p.id !== primaryId);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-chrome-btn
              data-no-drag
              aria-label="Split panel"
              aria-pressed={!!secondary}
              className={
                'h-5 w-5 inline-flex items-center justify-center rounded transition-colors '
                + (secondary
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground')
              }
            >
              <Rows2 className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Split: stack a second panel below</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {secondary ? 'Panel below' : 'Split: show below'}
        </DropdownMenuLabel>
        {options.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => pick(p.id)} className="gap-2">
            <p.Icon className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">{p.title}</span>
            {secondary === p.id && <Check className="h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
        {secondary && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setSecondary(null)} className="gap-2">
              <X className="h-4 w-4 text-muted-foreground" />
              Remove split
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Slim grab bar atop the docked panel: drag the grip to lift it into a live
 *  floating window, Split to stack a second panel below, chevron to collapse the
 *  pane to the rail. Title-less and close-less: the panel body owns those. */
function PanelChromeBar({ detachId }: { detachId: WorkspacePanelId }) {
  const setSidebarMode = useViewerStore((s) => s.setSidebarMode);
  const onPointerDown = usePanelDetachDrag(detachId);

  return (
    <div
      onPointerDown={onPointerDown}
      className="flex items-center gap-1 h-6 shrink-0 px-1.5 border-b border-border/60 bg-muted/20 select-none touch-none cursor-grab active:cursor-grabbing"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Grip className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
        </TooltipTrigger>
        <TooltipContent side="bottom">Drag to float, or onto another screen to pop out</TooltipContent>
      </Tooltip>
      <span className="flex-1" />
      <SplitMenu primaryId={detachId} />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-chrome-btn
            data-no-drag
            aria-label="Collapse sidebar to icons"
            onClick={() => setSidebarMode('collapsed')}
            className="h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Collapse to icons</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** The resize handle between the two split halves (#1266): a centered grip so
 *  it reads as draggable. Removing the split lives on the lower panel's own
 *  header close button (and the Split menu), so the divider stays clutter-free. */
function SplitDivider({ onResizeStart }: { onResizeStart: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onResizeStart}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize split"
      className="group relative h-2.5 shrink-0 cursor-row-resize flex items-center justify-center border-y border-border/60 bg-muted/30 hover:bg-primary/10 transition-colors"
    >
      <GripHorizontal className="h-3 w-3 text-muted-foreground/50 group-hover:text-primary/70 transition-colors" />
    </div>
  );
}

/** Two stacked panels joined by one resize handle; both halves reserve space
 *  (#1266). The body of each half owns its own header, so the split adds no
 *  duplicate title chrome. */
function SplitContainer({
  containerRef,
  ratio,
  onDividerDown,
  primary,
  secondaryId,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratio: number;
  onDividerDown: (e: React.MouseEvent) => void;
  primary: React.ReactNode;
  secondaryId: WorkspacePanelId;
}) {
  const setSecondary = useViewerStore((s) => s.setSidebarSecondaryPanel);
  return (
    <div ref={containerRef} className="h-full flex flex-col panel-container">
      {/* Top half: flex-basis is the ratio; min-height stops it collapsing. */}
      <div
        data-detach-root
        className="flex flex-col min-h-[120px] overflow-hidden"
        style={{ flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 1 }}
      >
        {primary}
      </div>
      <SplitDivider onResizeStart={onDividerDown} />
      {/* Bottom half fills the rest; the body's own header carries its title +
          close (closing it clears the split). */}
      <div className="flex-1 min-h-[120px] flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-hidden">
          {renderPanelBody(secondaryId, () => setSecondary(null))}
        </div>
      </div>
    </div>
  );
}

export function SidebarPanelHost() {
  const activePanel = useViewerStore((s) => s.sidebarActivePanel);
  const activeTool = useViewerStore((s) => s.activeTool);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const secondaryPanel = useViewerStore((s) => s.sidebarSecondaryPanel);
  const splitRatio = useViewerStore((s) => s.sidebarSplitRatio);
  const setSplitRatio = useViewerStore((s) => s.setSidebarSplitRatio);
  const { floatingIds, poppedIds, closePanel } = usePanelControls();

  // Divider drag: translate pointer Y within the pane into the top-half ratio.
  const containerRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);
  const onDividerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const move = (ev: MouseEvent) => {
        if (rect.height <= 0) return;
        setSplitRatio((ev.clientY - rect.top) / rect.height);
      };
      const teardown = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        dragCleanupRef.current = null;
      };
      const up = () => teardown();
      dragCleanupRef.current = teardown;
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [setSplitRatio],
  );

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

  // A split only renders when the secondary still resolves to an inline panel
  // (not floated / popped, not collapsed to the same id as the primary).
  const secondaryActive =
    secondaryPanel !== null &&
    secondaryPanel !== shown &&
    !floatingIds.has(secondaryPanel) &&
    !poppedIds.has(secondaryPanel);

  // Right-placed analysis extension / Add Element carry their own chrome and
  // never split.
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
    // Empty (Information detached) or no split: render single.
    if (shown === null || !secondaryActive) {
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
    // Information on top, a second panel below (the canonical example).
    return (
      <SplitContainer
        containerRef={containerRef}
        ratio={splitRatio}
        onDividerDown={onDividerDown}
        primary={
          <>
            <PanelChromeBar detachId="properties" />
            <div className="flex-1 min-h-0 overflow-hidden">{renderPanelBody('properties', () => {})}</div>
          </>
        }
        secondaryId={secondaryPanel as WorkspacePanelId}
      />
    );
  }

  // A docked analysis panel, optionally split with a second panel below.
  if (!secondaryActive) {
    return (
      // data-detach-root lets usePanelDetachDrag lift from the current docked
      // bounds instead of falling back to default float geometry.
      <div data-detach-root className="h-full flex flex-col panel-container">
        <PanelChromeBar detachId={shown} />
        <div className="flex-1 min-h-0 overflow-hidden">{renderPanelBody(shown, () => closePanel(shown))}</div>
      </div>
    );
  }
  return (
    <SplitContainer
      containerRef={containerRef}
      ratio={splitRatio}
      onDividerDown={onDividerDown}
      primary={
        <>
          <PanelChromeBar detachId={shown} />
          <div className="flex-1 min-h-0 overflow-hidden">{renderPanelBody(shown, () => closePanel(shown))}</div>
        </>
      }
      secondaryId={secondaryPanel as WorkspacePanelId}
    />
  );
}
