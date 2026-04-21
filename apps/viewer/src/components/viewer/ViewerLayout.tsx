/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MainToolbar } from './MainToolbar';
import { HierarchyPanel } from './HierarchyPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { StatusBar } from './StatusBar';
import { ViewportContainer } from './ViewportContainer';
import { KeyboardShortcutsDialog, useKeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useViewerStore } from '@/store';
import { EntityContextMenu } from './EntityContextMenu';
import { HoverTooltip } from './HoverTooltip';
import { BCFPanel } from './BCFPanel';
import { IDSPanel } from './IDSPanel';
import { LensPanel } from './LensPanel';
import { ListPanel } from './lists/ListPanel';
import { ScriptPanel } from './ScriptPanel';
import { GanttPanel } from './schedule/GanttPanel';
import { CommandPalette } from './CommandPalette';
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
  const shortcutsDialog = useKeyboardShortcutsDialog();

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

  // Detect mobile viewport
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 768;
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
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        {/* Keyboard Shortcuts Dialog */}
        <KeyboardShortcutsDialog open={shortcutsDialog.open} onClose={shortcutsDialog.close} />

        {/* Global Overlays */}
        <EntityContextMenu />
        <HoverTooltip />
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />

        {/* Main Toolbar */}
        <MainToolbar onShowShortcuts={shortcutsDialog.toggle} />
        <DesktopEntitlementBanner />

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
          <div className="flex-1 min-h-0 relative">
            {/* Full-screen Viewport */}
            <div className="h-full w-full">
              <ViewportContainer />
            </div>

            {/* Mobile Bottom Sheet - Hierarchy */}
            {!leftPanelCollapsed && (
              <div className="absolute inset-x-0 bottom-0 h-[50vh] bg-background border-t rounded-t-xl shadow-xl z-40 animate-in slide-in-from-bottom">
                <div className="flex items-center justify-between p-2 border-b">
                  <span className="font-medium text-sm">Hierarchy</span>
                  <button
                    className="p-1 hover:bg-muted rounded"
                    onClick={() => setLeftPanelCollapsed(true)}
                  >
                    <span className="sr-only">Close</span>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="h-[calc(50vh-48px)] overflow-auto">
                  <HierarchyPanel />
                </div>
              </div>
            )}

            {/* Mobile Bottom Sheet - Properties, BCF, IDS, or Lists */}
            {!rightPanelCollapsed && (
              <div className="absolute inset-x-0 bottom-0 h-[50vh] bg-background border-t rounded-t-xl shadow-xl z-40 animate-in slide-in-from-bottom">
                <div className="flex items-center justify-between p-2 border-b">
                  <span className="font-medium text-sm">
                    {activeAnalysisExtension ? activeAnalysisExtension.label : ganttPanelVisible ? 'Schedule' : scriptPanelVisible ? 'Script' : listPanelVisible ? 'Lists' : lensPanelVisible ? 'Lens' : idsPanelVisible ? 'IDS Validation' : bcfPanelVisible ? 'BCF Issues' : 'Inspector'}
                  </span>
                  <button
                    className="p-1 hover:bg-muted rounded"
                    onClick={() => {
                      setRightPanelCollapsed(true);
                      if (scriptPanelVisible) setScriptPanelVisible(false);
                      if (listPanelVisible) setListPanelVisible(false);
                      if (ganttPanelVisible) setGanttPanelVisible(false);
                      if (bcfPanelVisible) setBcfPanelVisible(false);
                      if (lensPanelVisible) setLensPanelVisible(false);
                      if (idsPanelVisible) setIdsPanelVisible(false);
                      if (activeAnalysisExtension) closeActiveAnalysisExtension();
                    }}
                  >
                    <span className="sr-only">Close</span>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="h-[calc(50vh-48px)] overflow-auto">
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
              </div>
            )}

            {/* Mobile Action Buttons */}
            <div className="absolute bottom-4 left-4 right-4 flex justify-center gap-2 z-30">
              <button
                className="px-4 py-2 bg-primary text-primary-foreground rounded-full shadow-lg text-sm font-medium"
                onClick={() => {
                  setRightPanelCollapsed(true);
                  setLeftPanelCollapsed(!leftPanelCollapsed);
                }}
              >
                Hierarchy
              </button>
              <button
                className="px-4 py-2 bg-primary text-primary-foreground rounded-full shadow-lg text-sm font-medium"
                onClick={() => {
                  setLeftPanelCollapsed(true);
                  setRightPanelCollapsed(!rightPanelCollapsed);
                }}
              >
                Inspector
              </button>
            </div>
          </div>
        )}

        {/* Status Bar */}
        <StatusBar />
      </div>
    </TooltipProvider>
  );
}
