/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';
import { MainToolbar } from './MainToolbar';
import { MobileToolbar } from './MobileToolbar';
import { RibbonToolbar } from './ribbon/RibbonToolbar';
import { HierarchyPanel } from './HierarchyPanel';
import { AddElementPanel } from './AddElementPanel';
import { StatusBar } from './StatusBar';
import { ViewportContainer } from './ViewportContainer';
import { KeyboardShortcutsDialog, useKeyboardShortcutsDialog, type InfoDialogTab } from './KeyboardShortcutsDialog';
import { SettingsDialogHost } from './settings/SettingsDialog';
import { ConfirmDialogHost } from '@/components/ui/confirm-dialog';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useUnexportedChangesGuard } from '@/hooks/useUnexportedChanges';
import { useSearchIndex } from '@/hooks/useSearchIndex';
import { useActionLogger } from '@/hooks/useActionLogger';
import { usePrivacyDisclosure } from '@/hooks/usePrivacyDisclosure';
import { isSafeMode } from '@/lib/safe-mode';
import { MobileBottomSheet, useVisualViewportBottomInset } from './MobileBottomSheet';
import { ShieldAlert } from 'lucide-react';
import { ExtensionDockHost } from '@/components/extensions/ExtensionDockHost';
import { useIfc } from '@/hooks/useIfc';
import { useModelUrlAutoload } from '@/hooks/useModelUrlAutoload';
import { useViewerStore } from '@/store';
import { isCollabEnabled } from '@/lib/collab/config';
import { toast } from '@/components/ui/toast';
import { parseRoleFromToken } from '@/lib/collab/share-link';
import { EntityContextMenu } from './EntityContextMenu';
import { AnonymizedExportDialog } from './anonymized-export/AnonymizedExportDialog';
import { useDuplicateShortcut } from './useDuplicateShortcut';
import { HoverTooltip } from './HoverTooltip';
import { BottomStrip } from './BottomStrip';
import { loadBottomStripOrientation, persistBottomStripOrientation } from '@/lib/panels/bottom-strip-persistence';
import { LEFT_PANEL_DEFAULT_SIZE } from '@/store/layoutReset';
import { useOverlayCompositor } from './schedule/useOverlayCompositor';
import { CommandPalette } from './CommandPalette';
import { SearchModal } from './SearchModal';
import { TourHost } from '@/components/tours/TourHost';
import { SidebarDock } from './sidebar/SidebarDock';
import { FloatingPanelHost } from './dock/FloatingPanelHost';
import { PanelWindowHost } from './dock/PanelWindowHost';
import {
  closeActiveAnalysisExtension,
  getAnalysisExtensionById,
  getAnalysisExtensionsSnapshot,
  subscribeAnalysisExtensions,
} from '@/services/analysis-extensions';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { activeBottomPanel } from '@/lib/panels/bottom-panels';
import { useBottomPanelFlags } from '@/hooks/useBottomPanelFlags';
import { getPanelDef } from '@/lib/panels/registry';
import { resolveMobileSheet } from '@/lib/panels/mobileSheet';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useMobileLayoutMode } from '@/hooks/useMobileLayoutMode';
import { useThemeDocumentClass } from './useThemeDocumentClass';
import { EVENT_OPEN_COMMAND_PALETTE } from '@/lib/tours/events';

/** Technical query flag rendered as code by the localized safe-mode notice. */
const SAFE_MODE_QUERY_FLAG = '?safe=0';

export function ViewerLayout() {
  const { t } = useTranslation();
  useSearchIndex();
  // Initialize keyboard shortcuts
  useKeyboardShortcuts();
  // ⌘D / Ctrl+D to duplicate the current selection.
  useDuplicateShortcut();
  useUnexportedChangesGuard(); // leaving the page with unexported edits asks first (#5604)
  // THE writer from the overlay-layer registry into the renderer's legacy
  // hiddenEntities / pendingColorUpdates channels. Mounted once, here, for
  // the whole session: a second instance would keep its own ownership map and
  // double-write. Layer owners (4D animation, charts, …) only register layers.
  useOverlayCompositor();
  // Bridge viewer state transitions into the extension action log so the idle pattern miner can surface one-click tool suggestions.
  useActionLogger();
  // Show the RFC §06 §7 privacy disclosure on first launch.
  usePrivacyDisclosure();
  const shortcutsDialog = useKeyboardShortcutsDialog();

  // Auto-load a model from ?model=<URL> (extracted to its own hook, #5851:
  // a malformed/cross-origin/failed fetch now shows the load-error card
  // instead of only `console.error`; see the hook's docblock).
  useModelUrlAutoload();

  // Deep-link collaboration join: a share link is `?room=…&t=…`. The recipient
  // joins the room; with seed-into-room the model hydrates from the Y.Doc, so
  // no `?model=` is needed. Guarded so StrictMode's double-invoke can't join twice,
  // and wrapped so a throw can't tear down the layout (uncaught throws unmount the canvas).
  const collabJoinDoneRef = useRef(false);
  useEffect(() => {
    if (collabJoinDoneRef.current) return;
    if (!isCollabEnabled()) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const roomId = params.get('room');
      if (!roomId) return;
      const token = params.get('t') ?? undefined;
      collabJoinDoneRef.current = true;
      const role = (token && parseRoleFromToken(token)) || 'viewer';
      void useViewerStore.getState().startCollab({ roomId, role, token });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab] deep-link join failed:', err);
    }
  }, []);

  // Surface a room whose geometry never arrived. The joiner sets this on the
  // store (slices hold no UI imports); this is the one place it becomes visible,
  // so a shared room rendering an empty scene says why instead of leaving the
  // recipient to assume they misconfigured something.
  const collabGeometryNotice = useViewerStore((s) => s.collabGeometryNotice);
  useEffect(() => {
    // Consume first: StrictMode's double-invoke then finds it already taken and
    // cannot toast the same message twice.
    const notice = useViewerStore.getState().consumeCollabGeometryNotice();
    if (notice) toast.error(notice);
  }, [collabGeometryNotice]);

  // Command palette state
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Ctrl+K / Cmd+K to open command palette
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const openCommandPalette = () => setCommandPaletteOpen(true);
    // With a `detail.tab` the event is a deep link (e.g. the Learn hub) and
    // always opens; without it, it keeps its legacy toggle semantics.
    const showShortcuts = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: InfoDialogTab } | undefined>).detail?.tab;
      if (tab) shortcutsDialog.openTab(tab);
      else shortcutsDialog.toggle();
    };

    window.addEventListener(EVENT_OPEN_COMMAND_PALETTE, openCommandPalette);
    window.addEventListener('ifc-lite:show-shortcuts', showShortcuts);
    return () => {
      window.removeEventListener(EVENT_OPEN_COMMAND_PALETTE, openCommandPalette);
      window.removeEventListener('ifc-lite:show-shortcuts', showShortcuts);
    };
  }, [shortcutsDialog]);

  // Desktop toolbar style (issue #1686): classic strip or tabbed ribbon.
  const toolbarStyle = useViewerStore((s) => s.toolbarStyle);
  const isMobile = useViewerStore((s) => s.isMobile);
  const leftPanelCollapsed = useViewerStore((s) => s.leftPanelCollapsed);
  const rightPanelCollapsed = useViewerStore((s) => s.rightPanelCollapsed);
  const setLeftPanelCollapsed = useViewerStore((s) => s.setLeftPanelCollapsed);
  const setRightPanelCollapsed = useViewerStore((s) => s.setRightPanelCollapsed);
  const activeTool = useViewerStore((s) => s.activeTool);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  // Which bottom panel the flags say is open (table precedence), and whether
  // it is actually docked here rather than floating / popped out.
  const bottomPanel = activeBottomPanel(useBottomPanelFlags());
  // The right pane is owned by the sidebar (#1208); here we only need to know which
  // BOTTOM panel (Script / Schedule / Lists) is docked vs detached, so the bottom strip skips a floating (#1201) or popped-out one.
  const floatingPanels = useViewerStore((s) => s.floatingPanels);
  const poppedOutIds = useViewerStore((s) => s.poppedOutIds);
  const detachedIds = useMemo(
    () => new Set<string>([...floatingPanels.map((p) => p.id), ...poppedOutIds]),
    [floatingPanels, poppedOutIds],
  );
  const dockedBottomPanel = bottomPanel && !detachedIds.has(bottomPanel) ? bottomPanel : null;

  // Side-by-side 2D/3D layout preset (#5515): a persisted dock-side choice
  // ("does Drawing go beside the viewport or below it") that only takes
  // effect while Drawing is the actual docked panel — switching the strip's
  // tab to anything else falls back to the normal bottom dock for it, same
  // as detaching Drawing itself already does above.
  const [stripOrientation, setStripOrientation] = useState(() => loadBottomStripOrientation());
  const toggleStripOrientation = useCallback(() => {
    setStripOrientation((prev) => {
      const next = prev === 'side' ? 'bottom' : 'side';
      persistBottomStripOrientation(next);
      return next;
    });
  }, []);
  const sideBySideDrawing = stripOrientation === 'side' && dockedBottomPanel === 'drawing';

  // ── Mobile bottom sheet ──
  // Mobile shows exactly ONE panel at a time, so resolve which, then render it
  // through the shared id → body map every other host uses. The hand-written
  // chain this replaces knew seven panels and fell through to PropertiesPanel for
  // the rest, so opening e.g. Compare or the collab Room on a phone showed the
  // Properties panel titled "Properties" — the wrong panel, not just a wrong label.
  const sidebarActivePanel = useViewerStore((s) => s.sidebarActivePanel);
  const { closePanel } = usePanelControls();
  const analysisExtensionState = useSyncExternalStore(
    subscribeAnalysisExtensions,
    getAnalysisExtensionsSnapshot,
    getAnalysisExtensionsSnapshot,
  );
  const activeAnalysisExtension = getAnalysisExtensionById(analysisExtensionState.activeId);
  const activeRightAnalysisExtension = (activeAnalysisExtension?.placement ?? 'right') === 'right'
    ? activeAnalysisExtension
    : null;
  const activeBottomAnalysisExtension = activeAnalysisExtension?.placement === 'bottom'
    ? activeAnalysisExtension
    : null;

  const mobileSheet = useMemo(() => resolveMobileSheet({
    hasAnalysisExtension: activeAnalysisExtension !== null && activeAnalysisExtension !== undefined,
    activeTool,
    bottomPanel,
    sidebarActivePanel,
  }), [activeAnalysisExtension, activeTool, bottomPanel, sidebarActivePanel]);

  // Panel ref for programmatic collapse/expand (command palette, keyboard
  // shortcuts). The right region is the unified sidebar (#1208), which owns its
  // own collapse/hide state in `sidebarSlice`; only the left hierarchy pane is a react-resizable Panel here.
  const leftPanelRef = useRef<PanelImperativeHandle>(null);

  // Sync store state → left Panel collapse/expand on desktop
  useEffect(() => {
    const panel = leftPanelRef.current;
    if (!panel) return;
    if (leftPanelCollapsed && !panel.isCollapsed()) panel.collapse();
    else if (!leftPanelCollapsed && panel.isCollapsed()) panel.expand();
  }, [leftPanelCollapsed]);
  const layoutResetEpoch = useViewerStore((s) => s.layoutResetEpoch); // "Reset layout" (#5854) restores the pane width
  useEffect(() => { if (layoutResetEpoch > 0) leftPanelRef.current?.resize(`${LEFT_PANEL_DEFAULT_SIZE}%`); }, [layoutResetEpoch]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Track the gap between the layout viewport (innerHeight) and the visual
  // viewport. On iOS Safari with bottom URL bar, dvh/innerHeight INCLUDES the
  // URL bar area, so `bottom: 0` lands behind it; visualViewport.height excludes it.
  const bottomViewportInset = useVisualViewportBottomInset();

  // Hide mobile floating buttons when the empty-state "Load IFC" card shows.
  const { models, geometryResult } = useIfc();
  const hasModelsLoaded = models.size > 0 || ((geometryResult?.meshes?.length ?? 0) > 0);

  // Mobile/desktop mode; collapses the panels only when ENTERING mobile (#5837).
  useMobileLayoutMode();

  useThemeDocumentClass();
  const safeMode = isSafeMode();

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen h-[100dvh] w-screen overflow-hidden bg-background text-foreground">
        {safeMode && (
          <div className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-700 dark:text-amber-300">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            <span>
              {styleInterpolatedValues(t, 'shellChrome.layout.safeModeNotice', [
                ['flag', <code key="flag" className="font-mono">{SAFE_MODE_QUERY_FLAG}</code>],
              ])}
            </span>
          </div>
        )}
        <KeyboardShortcutsDialog open={shortcutsDialog.open} onClose={shortcutsDialog.close} initialTab={shortcutsDialog.tab} />
        <SettingsDialogHost />
        <ConfirmDialogHost />
        {/* Global dialogs above, overlays below */}
        <EntityContextMenu />
        <HoverTooltip />
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
        <SearchModal />
        <TourHost />
        {/* Trigger-less: this instance exists so the entity context menu's
            "Export anonymized…" (which only sets `anonymizedExportRequested`,
            no trigger of its own) has a mounted dialog regardless of whether the export toolbar
            dropdown is open. Same host pattern as `FlavorDialog` in
            `StatusBar.tsx`; `toolbar/export-commands.ts` owns the `trigger` one. */}
        <AnonymizedExportDialog surface="context_menu" />

        {/* Main Toolbar — compact MobileToolbar on mobile; on desktop the
            user picks classic strip vs tabbed ribbon (issue #1686). */}
        {isMobile
          ? <MobileToolbar />
          : toolbarStyle === 'ribbon'
            ? <RibbonToolbar onShowShortcuts={shortcutsDialog.toggle} />
            : <MainToolbar onShowShortcuts={shortcutsDialog.toggle} />}

        {/* Main Content Area - Desktop Layout */}
        {!isMobile && (
          <div ref={containerRef} className="flex-1 min-h-0 flex flex-col relative">
            {/* Top: hierarchy | viewport split, with the unified sidebar (#1208)
                pinned to the right edge (its own activity bar + docked pane). */}
            <div className="flex-1 min-h-0 flex">
              <div className="flex-1 min-w-0">
                <PanelGroup orientation="horizontal" className="h-full">
                  {/* Left Panel - Hierarchy */}
                  <Panel
                    id="left-panel"
                    defaultSize={LEFT_PANEL_DEFAULT_SIZE}
                    minSize={10}
                    collapsible
                    collapsedSize={0}
                    panelRef={leftPanelRef}
                    onResize={() => {
                      const collapsed = leftPanelRef.current?.isCollapsed() ?? false;
                      if (collapsed !== leftPanelCollapsed) setLeftPanelCollapsed(collapsed);
                    }}
                  >
                    <div className="h-full w-full overflow-hidden panel-container flex flex-col">
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <HierarchyPanel />
                      </div>
                      {/* Extension dock.left — collapses when no extension
                          contributes. Sits beneath the hierarchy panel. */}
                      <ExtensionDockHost slot="dock.left" className="max-h-[40%] border-t" />
                    </div>
                  </Panel>

                  <PanelResizeHandle className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-col-resize" />

                  {/* Center - Viewport */}
                  <Panel id="viewport-panel" defaultSize={78} minSize={30}>
                    {/* data-floating-snap-bounds: edge-docked floating panels
                        (#1201) snap to THIS region, not the whole window, so a
                        dock never hides under the toolbar (its own close control
                        with it) or over the hierarchy / sidebar (#1245). */}
                    <div data-floating-snap-bounds className="h-full w-full overflow-hidden relative">
                      {sideBySideDrawing ? (
                        // Side-by-side 2D/3D preset (#5515): the drawing docks
                        // beside the 3D view instead of below it, in its own
                        // resizable split — same docked BottomStrip instance
                        // (tabs, maximize, close), just placed here instead of
                        // spanning the strip below.
                        <PanelGroup orientation="horizontal" className="h-full w-full">
                          <Panel id="viewport-3d-panel" defaultSize={60} minSize={20}>
                            <ViewportContainer />
                          </Panel>
                          <PanelResizeHandle className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-col-resize" />
                          <Panel id="drawing-side-panel" defaultSize={40} minSize={20}>
                            <BottomStrip
                              dockedPanel={dockedBottomPanel}
                              analysisExtension={null}
                              containerRef={containerRef}
                              closePanel={closePanel}
                              orientation="side"
                              onToggleOrientation={toggleStripOrientation}
                            />
                          </Panel>
                        </PanelGroup>
                      ) : (
                        <ViewportContainer />
                      )}
                    </div>
                  </Panel>
                </PanelGroup>
              </div>

              {/* Unified workspace sidebar: activity bar + docked panel host. */}
              <SidebarDock />
            </div>

            {/* Bottom strip — Schedule / Script / Lists / analysis ext. Launched from the
                sidebar rail but docked here (their home region); a panel dragged out to
                float / another screen, or side-by-side (#5515), is skipped. */}
            <BottomStrip
              dockedPanel={sideBySideDrawing ? null : dockedBottomPanel}
              analysisExtension={activeBottomAnalysisExtension}
              containerRef={containerRef}
              closePanel={closePanel}
              orientation="bottom"
              onToggleOrientation={toggleStripOrientation}
            />

            {/* Floating / docked workspace-panel windows (#1201) */}
            <FloatingPanelHost />
          </div>
        )}

        {/* Main Content Area - Mobile Layout */}
        {isMobile && (
          <div className="flex-1 min-h-0 relative overflow-hidden">
            {/* Full-screen Viewport */}
            <div className="h-full w-full">
              <ViewportContainer />
            </div>

            {/* Backdrop overlay when sheet is open */}
            {(!leftPanelCollapsed || !rightPanelCollapsed) && (
              <button type="button" aria-label={t('shellChrome.layout.closePanelsAriaLabel')}
                className="absolute inset-0 z-30 border-0 bg-black/40 p-0 animate-in fade-in duration-200"
                onClick={() => {
                  setLeftPanelCollapsed(true);
                  setRightPanelCollapsed(true);
                }}
              />
            )}

            {/* Mobile Bottom Sheet - Hierarchy */}
            {!leftPanelCollapsed && (
              <MobileBottomSheet
                title={t('shellChrome.layout.hierarchyLabel')}
                bottomInset={bottomViewportInset}
                onClose={() => setLeftPanelCollapsed(true)}
              >
                <HierarchyPanel />
              </MobileBottomSheet>
            )}

            {/* Mobile Bottom Sheet — whichever single panel is open.
                Analysis extensions and the Add Element tool are not registry
                panels, so they keep their own branches; everything else routes
                through `renderPanelBody`, the same map the sidebar, the
                floating host and the pop-out windows render from. */}
            {!rightPanelCollapsed && (
              <MobileBottomSheet
                title={mobileSheet.kind === 'extension' ? (activeAnalysisExtension?.label ?? t('shellChrome.layout.analysisFallback')) : mobileSheet.kind === 'addElement' ? t('shellChrome.layout.addElementLabel') : getPanelDef(mobileSheet.id)?.title ?? t('shellChrome.layout.informationFallback')}
                bottomInset={bottomViewportInset}
                onClose={() => {
                  setRightPanelCollapsed(true);
                  // Close ONLY what the sheet is showing. The close chain used to
                  // close the underlying sidebar panel too, so dismissing Add
                  // Element took an unrelated panel down with it.
                  if (mobileSheet.kind === 'extension') closeActiveAnalysisExtension();
                  else if (mobileSheet.kind === 'addElement') setActiveTool('select');
                  // Clears the dock flag AND float/pop-out channels, so closing
                  // the sheet can't leave the panel open where the phone has no room to show it.
                  else closePanel(mobileSheet.id);
                }}
              >
                {mobileSheet.kind === 'extension' ? (
                  (activeBottomAnalysisExtension ?? activeRightAnalysisExtension)
                    ?.renderPanel({ onClose: closeActiveAnalysisExtension })
                ) : mobileSheet.kind === 'addElement' ? (
                  <AddElementPanel onClose={() => setActiveTool('select')} />
                ) : (
                  renderPanelBody(mobileSheet.id, () => closePanel(mobileSheet.id))
                )}
              </MobileBottomSheet>
            )}

            {/* Mobile Floating Buttons — top-left, brutalist vocabulary (tight radii, visible
                borders, uppercase caption) matching panel headers across the app.
                Hidden in the empty state so the "Load IFC" card stays unobstructed. */}
            {leftPanelCollapsed && rightPanelCollapsed && hasModelsLoaded && (
              <div className="absolute top-4 left-4 flex flex-col gap-2.5 z-20">
                <button
                  className="flex flex-col items-center gap-1 group touch-manipulation"
                  onClick={() => { setRightPanelCollapsed(true); setLeftPanelCollapsed(false); }}
                  aria-label={t('shellChrome.layout.openHierarchyAriaLabel')}
                >
                  <span className="grid place-items-center min-h-[44px] min-w-[44px] bg-background/90 backdrop-blur-sm border border-border rounded-md group-active:bg-foreground group-active:text-background transition-colors">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h10M4 18h7" /></svg>
                  </span>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground leading-none">{t('shellChrome.layout.hierarchyLabel')}</span>
                </button>
                <button
                  className="flex flex-col items-center gap-1 group touch-manipulation"
                  onClick={() => { setLeftPanelCollapsed(true); setRightPanelCollapsed(false); }}
                  aria-label={t('shellChrome.layout.openPropertiesAriaLabel')}
                >
                  <span className="grid place-items-center min-h-[44px] min-w-[44px] bg-background/90 backdrop-blur-sm border border-border rounded-md group-active:bg-foreground group-active:text-background transition-colors">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  </span>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground leading-none">{t('shellChrome.layout.propertiesLabel')}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Extension dock.bottom slot — collapses to nothing when no
            extension contributes here. */}
        {!isMobile && (
          <div className="max-h-[40vh]">
            <ExtensionDockHost slot="dock.bottom" />
          </div>
        )}

        {/* Status Bar — hidden on mobile to maximize viewport space */}
        {!isMobile && <StatusBar />}

        {/* Panels popped out into OS / PiP windows (#1208) — portalled into the
            child documents; live-synced via the shared store. */}
        <PanelWindowHost />
      </div>
    </TooltipProvider>
  );
}
