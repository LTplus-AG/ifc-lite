/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MainToolbar } from './MainToolbar';
import { MobileToolbar } from './MobileToolbar';
import { HierarchyPanel } from './HierarchyPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { AddElementPanel } from './AddElementPanel';
import { StatusBar } from './StatusBar';
import { ViewportContainer } from './ViewportContainer';
import { KeyboardShortcutsDialog, useKeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useIfc } from '@/hooks/useIfc';
import { useViewerStore } from '@/store';
import { EntityContextMenu } from './EntityContextMenu';
import { useDuplicateShortcut } from './useDuplicateShortcut';
import { HoverTooltip } from './HoverTooltip';
import { BCFPanel } from './BCFPanel';
import { IDSPanel } from './IDSPanel';
import { LensPanel } from './LensPanel';
import { ListPanel } from './lists/ListPanel';
import { ScriptPanel } from './ScriptPanel';
import { GanttPanel } from './schedule/GanttPanel';
import { CommandPalette } from './CommandPalette';
import { SearchModal } from './SearchModal';
import { DesktopEntitlementBanner } from './DesktopEntitlementBanner';
import {
  closeActiveAnalysisExtension,
  getAnalysisExtensionById,
  getAnalysisExtensionsSnapshot,
  subscribeAnalysisExtensions,
} from '@/services/analysis-extensions';

const BOTTOM_PANEL_MIN_HEIGHT = 120;
const BOTTOM_PANEL_DEFAULT_HEIGHT = 300;
const BOTTOM_PANEL_MAX_RATIO = 0.7; // max 70% of container

export function ViewerLayout() {
  // Initialize keyboard shortcuts
  useKeyboardShortcuts();
  // ⌘D / Ctrl+D to duplicate the current selection.
  useDuplicateShortcut();
  const shortcutsDialog = useKeyboardShortcutsDialog();

  // Auto-load a model from ?model=<URL>. Used by the landing-page iframe to drop a
  // sample IFC into the viewer on first mount. Same-origin or CORS-friendly URLs only.
  const { addModel: autoloadAddModel } = useIfc();
  const autoloadDoneRef = useRef(false);
  useEffect(() => {
    if (autoloadDoneRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const modelUrl = params.get('model');
    if (!modelUrl) return;
    autoloadDoneRef.current = true;
    (async () => {
      try {
        const res = await fetch(modelUrl);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const blob = await res.blob();
        const filename = (() => {
          try { return new URL(modelUrl, window.location.href).pathname.split('/').pop() || 'model.ifc'; }
          catch { return 'model.ifc'; }
        })();
        const file = new File([blob], filename, { type: blob.type || 'application/x-step' });
        await autoloadAddModel(file);
      } catch (err) {
        console.error('[viewer] autoload from ?model=… failed:', err);
      }
    })();
  }, [autoloadAddModel]);

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
    const showShortcuts = () => shortcutsDialog.toggle();

    window.addEventListener('ifc-lite:open-command-palette', openCommandPalette);
    window.addEventListener('ifc-lite:show-shortcuts', showShortcuts);
    return () => {
      window.removeEventListener('ifc-lite:open-command-palette', openCommandPalette);
      window.removeEventListener('ifc-lite:show-shortcuts', showShortcuts);
    };
  }, [shortcutsDialog]);

  // Initialize theme on mount
  const theme = useViewerStore((s) => s.theme);
  const isMobile = useViewerStore((s) => s.isMobile);
  const setIsMobile = useViewerStore((s) => s.setIsMobile);
  const leftPanelCollapsed = useViewerStore((s) => s.leftPanelCollapsed);
  const rightPanelCollapsed = useViewerStore((s) => s.rightPanelCollapsed);
  const setLeftPanelCollapsed = useViewerStore((s) => s.setLeftPanelCollapsed);
  const setRightPanelCollapsed = useViewerStore((s) => s.setRightPanelCollapsed);
  const bcfPanelVisible = useViewerStore((s) => s.bcfPanelVisible);
  const setBcfPanelVisible = useViewerStore((s) => s.setBcfPanelVisible);
  const activeTool = useViewerStore((s) => s.activeTool);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const idsPanelVisible = useViewerStore((s) => s.idsPanelVisible);
  const setIdsPanelVisible = useViewerStore((s) => s.setIdsPanelVisible);
  const listPanelVisible = useViewerStore((s) => s.listPanelVisible);
  const setListPanelVisible = useViewerStore((s) => s.setListPanelVisible);
  const lensPanelVisible = useViewerStore((s) => s.lensPanelVisible);
  const setLensPanelVisible = useViewerStore((s) => s.setLensPanelVisible);
  const scriptPanelVisible = useViewerStore((s) => s.scriptPanelVisible);
  const setScriptPanelVisible = useViewerStore((s) => s.setScriptPanelVisible);
  const ganttPanelVisible = useViewerStore((s) => s.ganttPanelVisible);
  const setGanttPanelVisible = useViewerStore((s) => s.setGanttPanelVisible);
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

  // Panel refs for programmatic collapse/expand (command palette, keyboard shortcuts)
  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);

  // Sync store state → Panel collapse/expand on desktop
  useEffect(() => {
    const panel = leftPanelRef.current;
    if (!panel) return;
    if (leftPanelCollapsed && !panel.isCollapsed()) panel.collapse();
    else if (!leftPanelCollapsed && panel.isCollapsed()) panel.expand();
  }, [leftPanelCollapsed]);

  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    if (rightPanelCollapsed && !panel.isCollapsed()) panel.collapse();
    else if (!rightPanelCollapsed && panel.isCollapsed()) panel.expand();
  }, [rightPanelCollapsed]);

  // Bottom panel resize state (pixel height, persisted in ref to avoid re-renders during drag)
  const [bottomHeight, setBottomHeight] = useState(BOTTOM_PANEL_DEFAULT_HEIGHT);
  const containerRef = useRef<HTMLDivElement>(null);
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
  }, [bottomHeight]);

  // Track the gap between the layout viewport (innerHeight) and the visual viewport.
  // On iOS Safari with bottom URL bar, dvh/innerHeight INCLUDES the URL bar area,
  // so anything at `bottom: 0` lands behind it. visualViewport.height excludes
  // the URL bar overlay, giving us the real visible bottom.
  const bottomViewportInset = useVisualViewportBottomInset();

  // Hide mobile floating buttons when the empty-state "Load IFC" card is showing.
  const { models, geometryResult } = useIfc();
  const hasModelsLoaded = models.size > 0 || ((geometryResult?.meshes?.length ?? 0) > 0);

  // Detect mobile viewport — use both width check AND touch capability
  useEffect(() => {
    const checkMobile = () => {
      const narrowScreen = window.innerWidth < 768;
      const hasTouchScreen = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      const mobile = narrowScreen || (hasTouchScreen && window.innerWidth < 1024);
      setIsMobile(mobile);
      // Auto-collapse panels on mobile
      if (mobile) {
        setLeftPanelCollapsed(true);
        setRightPanelCollapsed(true);
      }
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [setIsMobile, setLeftPanelCollapsed, setRightPanelCollapsed]);

  // Keep DOM class in sync when theme changes (initial class is set by inline script in index.html)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('colorful', theme === 'colorful');
  }, [theme]);


  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen h-[100dvh] w-screen overflow-hidden bg-background text-foreground">
        {/* Keyboard Shortcuts Dialog */}
        <KeyboardShortcutsDialog open={shortcutsDialog.open} onClose={shortcutsDialog.close} />

        {/* Global Overlays */}
        <EntityContextMenu />
        <HoverTooltip />
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
        <SearchModal />

        {/* Main Toolbar — use compact MobileToolbar on mobile */}
        {isMobile ? <MobileToolbar /> : <MainToolbar onShowShortcuts={shortcutsDialog.toggle} />}
        {!isMobile && <DesktopEntitlementBanner />}

        {/* Main Content Area - Desktop Layout */}
        {!isMobile && (
          <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
            {/* Top: horizontal split (hierarchy | viewport | properties) */}
            <div className="flex-1 min-h-0">
              <PanelGroup orientation="horizontal" className="h-full">
                {/* Left Panel - Hierarchy */}
                <Panel
                  id="left-panel"
                  defaultSize={20}
                  minSize={10}
                  collapsible
                  collapsedSize={0}
                  panelRef={leftPanelRef}
                  onResize={() => {
                    const collapsed = leftPanelRef.current?.isCollapsed() ?? false;
                    if (collapsed !== leftPanelCollapsed) setLeftPanelCollapsed(collapsed);
                  }}
                >
                  <div className="h-full w-full overflow-hidden panel-container">
                    <HierarchyPanel />
                  </div>
                </Panel>

                <PanelResizeHandle className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-col-resize" />

                {/* Center - Viewport */}
                <Panel id="viewport-panel" defaultSize={58} minSize={30}>
                  <div className="h-full w-full overflow-hidden">
                    <ViewportContainer />
                  </div>
                </Panel>

                <PanelResizeHandle className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-col-resize" />

                {/* Right Panel - Properties, BCF, or IDS */}
                <Panel
                  id="right-panel"
                  defaultSize={22}
                  minSize={15}
                  collapsible
                  collapsedSize={0}
                  panelRef={rightPanelRef}
                  onResize={() => {
                    const collapsed = rightPanelRef.current?.isCollapsed() ?? false;
                    if (collapsed !== rightPanelCollapsed) setRightPanelCollapsed(collapsed);
                  }}
                >
                  <div className="h-full w-full overflow-hidden panel-container">
                    {activeRightAnalysisExtension ? (
                      activeRightAnalysisExtension.renderPanel({ onClose: closeActiveAnalysisExtension })
                    ) : activeTool === 'addElement' ? (
                      <AddElementPanel onClose={() => setActiveTool('select')} />
                    ) : lensPanelVisible ? (
                      <LensPanel onClose={() => setLensPanelVisible(false)} />
                    ) : idsPanelVisible ? (
                      <IDSPanel onClose={() => setIdsPanelVisible(false)} />
                    ) : bcfPanelVisible ? (
                      <BCFPanel onClose={() => setBcfPanelVisible(false)} />
                    ) : (
                      <PropertiesPanel />
                    )}
                  </div>
                </Panel>
              </PanelGroup>
            </div>

            {/* Bottom Panel - Lists / Script / Gantt / analysis ext (custom resizable) */}
            {(listPanelVisible || scriptPanelVisible || ganttPanelVisible || !!activeBottomAnalysisExtension) && (
              <div style={{ height: bottomHeight, flexShrink: 0 }} className="relative">
                {/* Drag handle */}
                <div
                  className="absolute inset-x-0 top-0 h-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-row-resize z-10"
                  onMouseDown={handleResizeStart}
                />
                <div className="h-full w-full overflow-hidden border-t pt-1.5">
                  {activeBottomAnalysisExtension ? (
                    activeBottomAnalysisExtension.renderPanel({ onClose: closeActiveAnalysisExtension })
                  ) : ganttPanelVisible ? (
                    <GanttPanel onClose={() => setGanttPanelVisible(false)} />
                  ) : scriptPanelVisible ? (
                    <ScriptPanel onClose={() => setScriptPanelVisible(false)} />
                  ) : (
                    <ListPanel onClose={() => setListPanelVisible(false)} />
                  )}
                </div>
              </div>
            )}
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
              <div
                className="absolute inset-0 bg-black/40 z-30 animate-in fade-in duration-200"
                onClick={() => {
                  setLeftPanelCollapsed(true);
                  setRightPanelCollapsed(true);
                }}
              />
            )}

            {/* Mobile Bottom Sheet - Hierarchy */}
            {!leftPanelCollapsed && (
              <MobileBottomSheet
                title="Hierarchy"
                bottomInset={bottomViewportInset}
                onClose={() => setLeftPanelCollapsed(true)}
              >
                <HierarchyPanel />
              </MobileBottomSheet>
            )}

            {/* Mobile Bottom Sheet - Properties, BCF, IDS, or Lists */}
            {!rightPanelCollapsed && (
              <MobileBottomSheet
                title={activeAnalysisExtension ? activeAnalysisExtension.label : ganttPanelVisible ? 'Schedule' : scriptPanelVisible ? 'Script' : listPanelVisible ? 'Lists' : activeTool === 'addElement' ? 'Add element' : lensPanelVisible ? 'Lens' : idsPanelVisible ? 'IDS Validation' : bcfPanelVisible ? 'BCF Issues' : 'Properties'}
                bottomInset={bottomViewportInset}
                onClose={() => {
                  setRightPanelCollapsed(true);
                  if (scriptPanelVisible) setScriptPanelVisible(false);
                  if (listPanelVisible) setListPanelVisible(false);
                  if (ganttPanelVisible) setGanttPanelVisible(false);
                  if (bcfPanelVisible) setBcfPanelVisible(false);
                  if (lensPanelVisible) setLensPanelVisible(false);
                  if (idsPanelVisible) setIdsPanelVisible(false);
                  if (activeAnalysisExtension) closeActiveAnalysisExtension();
                  if (activeTool === 'addElement') setActiveTool('select');
                }}
              >
                {activeBottomAnalysisExtension ? (
                  activeBottomAnalysisExtension.renderPanel({ onClose: closeActiveAnalysisExtension })
                ) : activeRightAnalysisExtension ? (
                  activeRightAnalysisExtension.renderPanel({ onClose: closeActiveAnalysisExtension })
                ) : ganttPanelVisible ? (
                  <GanttPanel onClose={() => setGanttPanelVisible(false)} />
                ) : scriptPanelVisible ? (
                  <ScriptPanel onClose={() => setScriptPanelVisible(false)} />
                ) : listPanelVisible ? (
                  <ListPanel onClose={() => setListPanelVisible(false)} />
                ) : activeTool === 'addElement' ? (
                  <AddElementPanel onClose={() => setActiveTool('select')} />
                ) : lensPanelVisible ? (
                  <LensPanel onClose={() => setLensPanelVisible(false)} />
                ) : idsPanelVisible ? (
                  <IDSPanel onClose={() => setIdsPanelVisible(false)} />
                ) : bcfPanelVisible ? (
                  <BCFPanel onClose={() => setBcfPanelVisible(false)} />
                ) : (
                  <PropertiesPanel />
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
                  onClick={() => {
                    setRightPanelCollapsed(true);
                    setLeftPanelCollapsed(false);
                  }}
                  aria-label="Open Hierarchy"
                >
                  <span className="grid place-items-center min-h-[44px] min-w-[44px] bg-background/90 backdrop-blur-sm border border-border rounded-md group-active:bg-foreground group-active:text-background transition-colors">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h10M4 18h7" /></svg>
                  </span>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground leading-none">Hierarchy</span>
                </button>
                <button
                  className="flex flex-col items-center gap-1 group touch-manipulation"
                  onClick={() => {
                    setLeftPanelCollapsed(true);
                    setRightPanelCollapsed(false);
                  }}
                  aria-label="Open Properties"
                >
                  <span className="grid place-items-center min-h-[44px] min-w-[44px] bg-background/90 backdrop-blur-sm border border-border rounded-md group-active:bg-foreground group-active:text-background transition-colors">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  </span>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground leading-none">Properties</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Status Bar — hidden on mobile to maximize viewport space */}
        {!isMobile && <StatusBar />}
      </div>
    </TooltipProvider>
  );
}

/**
 * Tracks the gap between the layout viewport (innerHeight) and the visual viewport.
 * Returns the number of pixels the layout viewport extends below the visible area —
 * i.e. how tall the iOS Safari URL bar overlay (or virtual keyboard) is.
 */
function useVisualViewportBottomInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const gap = window.innerHeight - vv.height - vv.offsetTop;
      setInset(Math.max(0, Math.round(gap)));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

/**
 * Mobile bottom sheet with three snap states (dismissed / default / expanded).
 * Drag the handle: down to shrink/dismiss, up to enlarge. Velocity-based flicks
 * cross thresholds instantly; otherwise the sheet snaps to the closest state.
 *
 * `bottomInset` lifts the sheet above the iOS Safari URL bar overlay.
 */
function MobileBottomSheet({
  title,
  onClose,
  bottomInset,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  bottomInset: number;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startT: number; startHeight: number; active: boolean }>({
    startY: 0,
    startT: 0,
    startHeight: 0,
    active: false,
  });

  const SPRING = 'height 220ms cubic-bezier(0.2, 0, 0, 1)';

  const getSnapPoints = useCallback(() => {
    const h = window.visualViewport?.height ?? window.innerHeight;
    return {
      collapsed: 0,
      defaultH: Math.round(h * 0.6),
      expanded: Math.round(h * 0.92),
    };
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    dragRef.current = {
      startY: e.clientY,
      startT: performance.now(),
      startHeight: sheet.getBoundingClientRect().height,
      active: true,
    };
    sheet.style.transition = 'none';
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    if (!dragRef.current.active || !sheet) return;
    const dy = e.clientY - dragRef.current.startY;
    const { expanded } = getSnapPoints();
    const newHeight = Math.max(0, Math.min(expanded, dragRef.current.startHeight - dy));
    sheet.style.height = `${newHeight}px`;
  }, [getSnapPoints]);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    if (!dragRef.current.active || !sheet) return;
    dragRef.current.active = false;
    const dy = e.clientY - dragRef.current.startY;
    const dt = Math.max(1, performance.now() - dragRef.current.startT);
    // Positive velocity = upward drag (intent: enlarge).
    const upwardVelocity = -dy / dt; // px/ms
    const { collapsed, defaultH, expanded } = getSnapPoints();
    const currentHeight = sheet.getBoundingClientRect().height;

    sheet.style.transition = SPRING;

    const snapTo = (h: number) => {
      sheet.style.height = `${h}px`;
    };

    // Velocity-driven decisions take precedence over position.
    if (upwardVelocity > 0.5) {
      snapTo(expanded);
      return;
    }
    if (upwardVelocity < -0.5) {
      // Downward flick: from expanded → default, from default → dismiss.
      if (dragRef.current.startHeight >= expanded - 8) {
        snapTo(defaultH);
      } else {
        snapTo(collapsed);
        window.setTimeout(onClose, 200);
      }
      return;
    }

    // Position-based snap: closest of the three targets.
    const targets: Array<{ state: 'collapsed' | 'default' | 'expanded'; h: number }> = [
      { state: 'collapsed', h: collapsed },
      { state: 'default', h: defaultH },
      { state: 'expanded', h: expanded },
    ];
    let closest = targets[1];
    for (const t of targets) {
      if (Math.abs(currentHeight - t.h) < Math.abs(currentHeight - closest.h)) closest = t;
    }
    snapTo(closest.h);
    if (closest.state === 'collapsed') window.setTimeout(onClose, 200);
  }, [getSnapPoints, onClose]);

  // Initial height = default snap. Recompute when viewport changes (URL bar collapses).
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const { defaultH } = getSnapPoints();
    sheet.style.height = `${defaultH}px`;
  }, [getSnapPoints]);

  return (
    <div
      ref={sheetRef}
      className="absolute inset-x-0 flex flex-col bg-background border-t rounded-t-2xl shadow-2xl z-40 animate-in slide-in-from-bottom duration-300"
      style={{ bottom: `${bottomInset}px` }}
    >
      {/* Drag affordance — generously sized for touch */}
      <div
        className="grid place-items-center pt-3 pb-2 cursor-grab active:cursor-grabbing touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="button"
        aria-label="Drag to resize or dismiss"
      >
        <div className="w-10 h-1.5 rounded-full bg-muted-foreground/40" />
      </div>
      <div className="flex items-center justify-between px-4 pb-2 shrink-0">
        <span className="font-semibold text-sm">{title}</span>
        <button
          className="p-2 -mr-2 hover:bg-muted rounded-full active:bg-muted/80 touch-manipulation"
          onClick={onClose}
          aria-label="Close"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto overscroll-contain border-t">
        {children}
      </div>
    </div>
  );
}
