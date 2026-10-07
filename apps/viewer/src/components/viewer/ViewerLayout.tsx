/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';
import { MobileToolbar } from './MobileToolbar';
import { RibbonToolbar } from './ribbon/RibbonToolbar';
import { HierarchyPanel } from './HierarchyPanel';
import { StatusBar } from './StatusBar';
import { ViewportContainer } from './ViewportContainer';
import { ModelToolRail } from './model/ModelToolRail';
import { ModelWorkspaceSplit } from './model/ModelWorkspaceSplit';
import { KeyboardShortcutsDialog, useKeyboardShortcutsDialog, type InfoDialogTab } from './KeyboardShortcutsDialog';
import { SettingsDialogHost } from './settings/SettingsDialog';
import { ConfirmDialogHost } from '@/components/ui/confirm-dialog';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { ShellStoreEffects } from './ShellStoreEffects';
import { selectHasModelsLoaded } from '@/hooks/model-presence';
import { useActionLogger } from '@/hooks/useActionLogger';
import { usePrivacyDisclosure } from '@/hooks/usePrivacyDisclosure';
import { isSafeMode } from '@/lib/safe-mode';
import { MobileBottomSheet, useVisualViewportBottomInset } from './MobileBottomSheet';
import { MobilePanelLauncher } from './MobilePanelLauncher';
import { MobilePanelSheet } from './MobilePanelSheet';
import { ShieldAlert } from 'lucide-react';
import { ExtensionDockHost } from '@/components/extensions/ExtensionDockHost';
import { ExtensionKeyboardBindings } from '@/components/extensions/ExtensionKeyboardBindings';
import { useModelUrlAutoload } from '@/hooks/useModelUrlAutoload';
import { useArtifactDeepLink } from '@/hooks/useArtifactDeepLink';
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
import { FlowStartupPrompt } from './flow/FlowStartupPrompt';
import { TourHost } from '@/components/tours/TourHost';
import { SidebarDock } from './sidebar/SidebarDock';
const LayoutMigrationNotice = lazy(() => import('./sidebar/LayoutMigrationNotice').then(module => ({ default: module.LayoutMigrationNotice })));
import { FloatingPanelHost } from './dock/FloatingPanelHost';
import { PanelWindowHost } from './dock/PanelWindowHost';
import {
  getAnalysisExtensionById,
  getAnalysisExtensionsSnapshot,
  subscribeAnalysisExtensions,
} from '@/services/analysis-extensions';
import { activeBottomPanel } from '@/lib/panels/bottom-panels';
import { useBottomPanelFlags } from '@/hooks/useBottomPanelFlags';
import { usePanelControls } from '@/hooks/usePanelControls';
import { useMobileLayoutMode } from '@/hooks/useMobileLayoutMode';
import { useThemeDocumentClass } from './useThemeDocumentClass';
import { EVENT_OPEN_COMMAND_PALETTE } from '@/lib/tours/events';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';

/** Technical query flag rendered as code by the localized safe-mode notice. */
const SAFE_MODE_QUERY_FLAG = '?safe=0';

export function ViewerLayout() {
  const { t } = useTranslation();
  // Initialize keyboard shortcuts
  useKeyboardShortcuts();
  // ⌘D / Ctrl+D to duplicate the current selection.
  useDuplicateShortcut();
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

  // ?model=<URL> autoload (#5851, load errors shown) and ?panel=/artifact deep links (#6927).
  useModelUrlAutoload();
  useArtifactDeepLink();

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

  // The shared dispatcher owns the Ctrl+K chord and text-entry exception.
  useEffect(() => {
    return registerKeyboardCommand('ui.commandPalette', () => {
      setCommandPaletteOpen((prev) => !prev);
    }, { allowInTextEntry: true });
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

  const isMobile = useViewerStore((s) => s.isMobile);
  const hasLayoutMigration = useViewerStore((s) => s.layoutMigrationChanges.length > 0);
  const leftPanelCollapsed = useViewerStore((s) => s.leftPanelCollapsed);
  const rightPanelCollapsed = useViewerStore((s) => s.rightPanelCollapsed);
  const setLeftPanelCollapsed = useViewerStore((s) => s.setLeftPanelCollapsed);
  const setRightPanelCollapsed = useViewerStore((s) => s.setRightPanelCollapsed);
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

  // The narrow layout's single-panel sheet lives in `MobilePanelSheet`; the
  // desktop bottom strip below still needs the close action and the extension.
  const { closePanel } = usePanelControls();
  const analysisExtensionState = useSyncExternalStore(
    subscribeAnalysisExtensions,
    getAnalysisExtensionsSnapshot,
    getAnalysisExtensionsSnapshot,
  );
  const activeAnalysisExtension = getAnalysisExtensionById(analysisExtensionState.activeId);
  const activeBottomAnalysisExtension = activeAnalysisExtension?.placement === 'bottom'
    ? activeAnalysisExtension
    : null;

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
  // A boolean selector, not `useIfc()`: that hook subscribes to `models` and
  // `geometryResult`, so every geometry update re-rendered the whole layout (#6232).
  const hasModelsLoaded = useViewerStore(selectHasModelsLoaded);

  // Mobile/desktop mode; collapses the panels only when ENTERING mobile (#5837).
  useMobileLayoutMode();

  useThemeDocumentClass();
  const safeMode = isSafeMode();
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen h-[100dvh] w-screen overflow-hidden bg-background text-foreground">
        <ExtensionKeyboardBindings />
        <ShellStoreEffects />
        {safeMode && (
          <div className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1 text-2xs text-amber-700 dark:text-amber-300">
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
        <FlowStartupPrompt />
        {/* Trigger-less: this instance exists so the entity context menu's
            "Export anonymized…" (which only sets `anonymizedExportRequested`,
            no trigger of its own) has a mounted dialog regardless of whether the export toolbar
            dropdown is open. Same host pattern as `FlavorDialog` in
            `StatusBar.tsx`; `toolbar/export-commands.ts` owns the `trigger` one. */}
        <AnonymizedExportDialog surface="context_menu" />
        {/* The compact mobile controls and the desktop ribbon share command homes. */}
        {isMobile
          ? <MobileToolbar />
          : <RibbonToolbar onShowShortcuts={shortcutsDialog.toggle} />}

        {isMobile && hasLayoutMigration && <Suspense fallback={null}><LayoutMigrationNotice /></Suspense>}

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
                  <Panel id="viewport-panel" defaultSize={100 - LEFT_PANEL_DEFAULT_SIZE} minSize={30}>
                    {/* data-floating-snap-bounds: edge-docked floating panels
                        (#1201) snap to THIS region, not the whole window, so a
                        dock never hides under the toolbar (its own close control
                        with it) or over the hierarchy / sidebar (#1245). */}
                    <div data-floating-snap-bounds className="h-full w-full overflow-hidden relative flex">
                      {/* Model workspace (#6232): its tool rail, then the Plan ‖ 3D split. */}
                      <ModelToolRail />
                      <ModelWorkspaceSplit>
                      {sideBySideDrawing ? (
                        // Side-by-side 2D/3D preset (#5515): the drawing docks
                        // beside the 3D view instead of below it, in its own
                        // resizable split — same docked BottomStrip instance
                        // (tabs, maximize, close), just placed here instead of
                        // spanning the strip below.
                        <PanelGroup orientation="horizontal" className="h-full w-full">
                          <Panel id="viewport-3d-panel" defaultSize="60%" minSize="20%">
                            <ViewportContainer />
                          </Panel>
                          <PanelResizeHandle className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-col-resize" />
                          <Panel id="drawing-side-panel" defaultSize="40%" minSize="20%">
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
                      </ModelWorkspaceSplit>
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

            {/* Mobile Bottom Sheet — whichever single panel is open (`MobilePanelSheet`). */}
            <MobilePanelSheet bottomInset={bottomViewportInset} analysisExtension={activeAnalysisExtension ?? null} />

            {/* Mobile Floating Buttons: Hierarchy, Properties and the Panels list
                (#5853). Hidden in the empty state so the "Load IFC" card stays unobstructed. */}
            {leftPanelCollapsed && rightPanelCollapsed && hasModelsLoaded && (
              <MobilePanelLauncher bottomInset={bottomViewportInset} />
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
