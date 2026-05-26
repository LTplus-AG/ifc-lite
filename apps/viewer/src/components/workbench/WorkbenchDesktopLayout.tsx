/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { GripVertical, LayoutDashboard, Plus, RotateCcw, X } from 'lucide-react';
import {
  BUILTIN_PANEL_IDS,
  type WorkbenchPanelId,
  type WorkbenchZoneId,
} from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { AddElementPanel } from '@/components/viewer/AddElementPanel';
import { BCFPanel } from '@/components/viewer/BCFPanel';
import { ExtensionsPanel } from '@/components/extensions/ExtensionsPanel';
import { GanttPanel } from '@/components/viewer/schedule/GanttPanel';
import { HierarchyPanel } from '@/components/viewer/HierarchyPanel';
import { IDSPanel } from '@/components/viewer/IDSPanel';
import { LensPanel } from '@/components/viewer/LensPanel';
import { ListPanel } from '@/components/viewer/lists/ListPanel';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { ScriptPanel } from '@/components/viewer/ScriptPanel';
import { ViewportContainer } from '@/components/viewer/ViewportContainer';
import { ExtensionDockHost } from '@/components/extensions/ExtensionDockHost';
import { WidgetRenderer, type WidgetRendererContext } from '@/components/extensions/widget/WidgetRenderer';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import {
  closeActiveAnalysisExtension,
  getAnalysisExtensionById,
  getAnalysisExtensionsSnapshot,
} from '@/services/analysis-extensions';
import { PersonalPanelDialog } from './PersonalPanelDialog';

const ZONE_LABEL: Record<WorkbenchZoneId, string> = { left: 'Left dock', right: 'Right dock', bottom: 'Bottom dock' };
const BOTTOM_PANEL_MIN_HEIGHT = 120;
const BOTTOM_PANEL_MAX_RATIO = 0.7;

interface WorkbenchDesktopLayoutProps {
  analysisExtensionState: ReturnType<typeof getAnalysisExtensionsSnapshot>;
}

export function WorkbenchDesktopLayout({ analysisExtensionState }: WorkbenchDesktopLayoutProps) {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const morphMode = useViewerStore((s) => s.workbenchMorphMode);
  const setMorphMode = useViewerStore((s) => s.setWorkbenchMorphMode);
  const setSizes = useViewerStore((s) => s.setWorkbenchHorizontalSizes);
  const setBottomHeight = useViewerStore((s) => s.setWorkbenchBottomHeight);
  const setCollapsed = useViewerStore((s) => s.setWorkbenchCollapsed);
  const resetLayout = useViewerStore((s) => s.resetWorkbenchLayout);
  const [personalOpen, setPersonalOpen] = useState(false);
  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeAnalysisExtension = getAnalysisExtensionById(analysisExtensionState.activeId);
  const activeRightAnalysisExtension = (activeAnalysisExtension?.placement ?? 'right') === 'right'
    ? activeAnalysisExtension
    : null;
  const activeBottomAnalysisExtension = activeAnalysisExtension?.placement === 'bottom'
    ? activeAnalysisExtension
    : null;

  useLegacyPanelSync();
  useAutoPersistLayout();

  useEffect(() => {
    const panel = leftPanelRef.current;
    if (!panel) return;
    if (layout.collapsed.left && !panel.isCollapsed()) panel.collapse();
    else if (!layout.collapsed.left && panel.isCollapsed()) panel.expand();
  }, [layout.collapsed.left]);

  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    if (layout.collapsed.right && !panel.isCollapsed()) panel.collapse();
    else if (!layout.collapsed.right && panel.isCollapsed()) panel.expand();
  }, [layout.collapsed.right]);

  const handleResizeStart = useBottomResize(containerRef, layout.sizes.bottomHeight, setBottomHeight);

  return (
    <div ref={containerRef} className="flex-1 min-h-0 flex flex-col relative">
      <MorphToolbar
        enabled={morphMode}
        onToggle={() => setMorphMode(!morphMode)}
        onAddPanel={() => setPersonalOpen(true)}
        onReset={() => {
          resetLayout();
          toast.success('Layout reset to IFC Lite default.');
        }}
      />
      <div className="flex-1 min-h-0">
        <PanelGroup
          orientation="horizontal"
          className="h-full"
          onLayout={(sizes) => {
            if (sizes.length === 3) setSizes([sizes[0], sizes[1], sizes[2]]);
          }}
        >
          <Panel
            id="left-panel"
            defaultSize={layout.sizes.horizontal[0]}
            minSize={10}
            collapsible
            collapsedSize={0}
            panelRef={leftPanelRef}
            onResize={() => setCollapsed('left', leftPanelRef.current?.isCollapsed() ?? false)}
          >
            <WorkbenchZone zone="left" morphMode={morphMode} />
          </Panel>
          <PanelResizeHandle className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-col-resize" />
          <Panel id="viewport-panel" defaultSize={layout.sizes.horizontal[1]} minSize={30}>
            <div className="h-full w-full overflow-hidden">
              <ViewportContainer />
            </div>
          </Panel>
          <PanelResizeHandle className="w-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-col-resize" />
          <Panel
            id="right-panel"
            defaultSize={layout.sizes.horizontal[2]}
            minSize={15}
            collapsible
            collapsedSize={0}
            panelRef={rightPanelRef}
            onResize={() => setCollapsed('right', rightPanelRef.current?.isCollapsed() ?? false)}
          >
            {activeRightAnalysisExtension
              ? <div className="h-full panel-container">{activeRightAnalysisExtension.renderPanel({ onClose: closeActiveAnalysisExtension })}</div>
              : <WorkbenchZone zone="right" morphMode={morphMode} />}
          </Panel>
        </PanelGroup>
      </div>
      {(activeBottomAnalysisExtension || layout.activeTabs.bottom) && !layout.collapsed.bottom && (
        <div style={{ height: layout.sizes.bottomHeight, flexShrink: 0 }} className="relative">
          <div
            className="absolute inset-x-0 top-0 h-1.5 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-row-resize z-10"
            onMouseDown={handleResizeStart}
          />
          <div className="h-full w-full overflow-hidden border-t pt-1.5">
            {activeBottomAnalysisExtension
              ? activeBottomAnalysisExtension.renderPanel({ onClose: closeActiveAnalysisExtension })
              : <WorkbenchZone zone="bottom" morphMode={morphMode} />}
          </div>
        </div>
      )}
      <div className="max-h-[32vh]">
        <ExtensionDockHost slot="dock.bottom" />
      </div>
      <PersonalPanelDialog open={personalOpen} onClose={() => setPersonalOpen(false)} />
    </div>
  );
}

function WorkbenchZone({ zone, morphMode }: { zone: WorkbenchZoneId; morphMode: boolean }) {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const activeTab = layout.activeTabs[zone] ?? layout.zones[zone][0];
  const setActive = useViewerStore((s) => s.setWorkbenchActiveTab);
  const movePanel = useViewerStore((s) => s.moveWorkbenchPanel);
  const zonePanels = layout.zones[zone].filter((id) => !layout.panelChrome[id]?.hidden);
  const activePanel = zonePanels.includes(activeTab ?? '') ? activeTab : zonePanels[0];

  return (
    <DropZone zone={zone} enabled={morphMode} onDropPanel={(panelId) => movePanel(panelId, zone)}>
      <div className="h-full w-full overflow-hidden panel-container flex flex-col">
        <div className={cn('flex items-center gap-1 border-b bg-muted/30 overflow-x-auto', morphMode && 'ring-1 ring-primary/40')}>
          {zonePanels.map((panelId) => (
            <PanelTab
              key={panelId}
              panelId={panelId}
              active={panelId === activePanel}
              morphMode={morphMode}
              onClick={() => setActive(zone, panelId)}
            />
          ))}
          {morphMode && (
            <div className="ml-auto px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {ZONE_LABEL[zone]}
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {activePanel ? <WorkbenchPanel panelId={activePanel} zone={zone} /> : <EmptyZone zone={zone} />}
        </div>
        {zone !== 'bottom' && <ExtensionDockHost slot={zone === 'left' ? 'dock.left' : 'dock.right'} className="max-h-[35%] border-t" />}
      </div>
    </DropZone>
  );
}

function PanelTab({ panelId, active, morphMode, onClick }: { panelId: string; active: boolean; morphMode: boolean; onClick: () => void }) {
  const title = usePanelTitle(panelId);
  return (
    <button
      type="button"
      draggable={morphMode}
      onDragStart={(event) => event.dataTransfer.setData('application/x-ifc-lite-panel', panelId)}
      onClick={onClick}
      className={cn(
        'shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs border-b-2 transition-colors',
        active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
      title={morphMode ? `Drag ${title} to another dock` : title}
    >
      {morphMode && <GripVertical className="h-3 w-3" />}
      {title}
    </button>
  );
}

function WorkbenchPanel({ panelId, zone }: { panelId: string; zone: WorkbenchZoneId }) {
  const closePanel = useClosePanel(panelId, zone);
  const personal = useViewerStore((s) => s.workbenchLayout.personalPanels[panelId]);
  const ctx = usePersonalWidgetContext();
  if (personal) {
    return (
      <ScrollArea className="h-full">
        <div className="p-3">
          <WidgetRenderer node={personal.widget as Parameters<typeof WidgetRenderer>[0]['node']} ctx={ctx} />
        </div>
      </ScrollArea>
    );
  }
  switch (panelId) {
    case BUILTIN_PANEL_IDS.hierarchy: return <HierarchyPanel />;
    case BUILTIN_PANEL_IDS.properties: return <PropertiesPanel />;
    case BUILTIN_PANEL_IDS.bcf: return <BCFPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.ids: return <IDSPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.lens: return <LensPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.extensions: return <ExtensionsPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.addElement: return <AddElementPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.lists: return <ListPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.script: return <ScriptPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.gantt: return <GanttPanel onClose={closePanel} />;
    default: return <EmptyPanel panelId={panelId} />;
  }
}

function MorphToolbar({ enabled, onToggle, onAddPanel, onReset }: { enabled: boolean; onToggle: () => void; onAddPanel: () => void; onReset: () => void }) {
  return (
    <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded border bg-background/90 p-1 shadow-sm backdrop-blur">
      <Button type="button" size="sm" variant={enabled ? 'default' : 'secondary'} onClick={onToggle}>
        <LayoutDashboard className="mr-1 h-3.5 w-3.5" />
        {enabled ? 'Morphing' : 'Morph UI'}
      </Button>
      {enabled && (
        <>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onAddPanel} aria-label="Add personal panel">
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onReset} aria-label="Reset layout">
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

function DropZone({ zone, enabled, onDropPanel, children }: { zone: WorkbenchZoneId; enabled: boolean; onDropPanel: (panelId: string) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cn('h-full w-full', over && 'outline outline-2 outline-primary outline-offset-[-2px]')}
      onDragOver={(event) => {
        if (!enabled || !event.dataTransfer.types.includes('application/x-ifc-lite-panel')) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const panelId = event.dataTransfer.getData('application/x-ifc-lite-panel');
        if (enabled && panelId) onDropPanel(panelId);
      }}
      aria-label={`${ZONE_LABEL[zone]} drop zone`}
    >
      {children}
    </div>
  );
}

function useLegacyPanelSync() {
  const bcf = useViewerStore((s) => s.bcfPanelVisible);
  const ids = useViewerStore((s) => s.idsPanelVisible);
  const lens = useViewerStore((s) => s.lensPanelVisible);
  const extensions = useViewerStore((s) => s.extensionsPanelVisible);
  const lists = useViewerStore((s) => s.listPanelVisible);
  const script = useViewerStore((s) => s.scriptPanelVisible);
  const gantt = useViewerStore((s) => s.ganttPanelVisible);
  const addElement = useViewerStore((s) => s.activeTool === 'addElement');
  const open = useViewerStore((s) => s.openWorkbenchPanel);
  useEffect(() => {
    if (bcf) open(BUILTIN_PANEL_IDS.bcf);
    if (ids) open(BUILTIN_PANEL_IDS.ids);
    if (lens) open(BUILTIN_PANEL_IDS.lens);
    if (extensions) open(BUILTIN_PANEL_IDS.extensions);
    if (lists) open(BUILTIN_PANEL_IDS.lists);
    if (script) open(BUILTIN_PANEL_IDS.script);
    if (gantt) open(BUILTIN_PANEL_IDS.gantt);
    if (addElement) open(BUILTIN_PANEL_IDS.addElement);
  }, [addElement, bcf, extensions, gantt, ids, lens, lists, open, script]);
}

function useClosePanel(panelId: string, zone: WorkbenchZoneId): () => void {
  return useCallback(() => {
    const state = useViewerStore.getState();
    if (panelId === BUILTIN_PANEL_IDS.bcf) state.setBcfPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.ids) state.setIdsPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.lens) state.setLensPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.extensions) state.setExtensionsPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.lists) state.setListPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.script) state.setScriptPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.gantt) state.setGanttPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.addElement) state.setActiveTool('select');
    state.setWorkbenchActiveTab(zone, zone === 'right' ? BUILTIN_PANEL_IDS.properties : undefined);
  }, [panelId, zone]);
}

function usePanelTitle(panelId: string): string {
  return useViewerStore((s) => {
    const chromeTitle = s.workbenchLayout.panelChrome[panelId]?.title;
    if (chromeTitle) return chromeTitle;
    const personal = s.workbenchLayout.personalPanels[panelId];
    if (personal) return personal.title;
    return BUILTIN_TITLES[panelId] ?? panelId;
  });
}

function usePersonalWidgetContext(): WidgetRendererContext {
  const host = useOptionalExtensionHost();
  return useMemo(() => ({
    state: {},
    invokeCommand: (commandId: string) => {
      host?.runCommand(commandId).catch((err) => {
        console.warn('[WorkbenchDesktopLayout] personal panel command failed:', err);
      });
    },
  }), [host]);
}

function useAutoPersistLayout() {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const host = useOptionalExtensionHost();
  const lastSavedRef = useRef('');
  useEffect(() => {
    if (!host) return;
    const serialized = JSON.stringify(layout);
    if (serialized === lastSavedRef.current) return;
    const handle = window.setTimeout(() => {
      void (async () => {
        const active = await host.flavors.getActive();
        if (!active) return;
        lastSavedRef.current = serialized;
        await host.flavors.put({
          ...active,
          layout: { state: layout },
          updatedAt: new Date().toISOString(),
        }, 'layout morph');
      })().catch((err) => {
        console.warn('[WorkbenchDesktopLayout] layout persistence failed:', err);
      });
    }, 600);
    return () => window.clearTimeout(handle);
  }, [host, layout]);
}

function useBottomResize(
  containerRef: RefObject<HTMLDivElement | null>,
  bottomHeight: number,
  setBottomHeight: (height: number) => void,
): (event: ReactMouseEvent) => void {
  return useCallback((event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = bottomHeight;
    const onMouseMove = (moveEvent: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const maxHeight = container.clientHeight * BOTTOM_PANEL_MAX_RATIO;
      const delta = startY - moveEvent.clientY;
      setBottomHeight(Math.min(maxHeight, Math.max(BOTTOM_PANEL_MIN_HEIGHT, startHeight + delta)));
    };
    const cleanup = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', cleanup);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', cleanup);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [bottomHeight, containerRef, setBottomHeight]);
}

function EmptyZone({ zone }: { zone: WorkbenchZoneId }) {
  return <div className="p-4 text-xs text-muted-foreground">Drop a panel into the {ZONE_LABEL[zone].toLowerCase()}.</div>;
}

function EmptyPanel({ panelId }: { panelId: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
      <X className="mr-2 h-4 w-4" />
      Panel unavailable: {panelId}
    </div>
  );
}

const BUILTIN_TITLES: Record<string, string> = {
  [BUILTIN_PANEL_IDS.hierarchy]: 'Hierarchy',
  [BUILTIN_PANEL_IDS.properties]: 'Properties',
  [BUILTIN_PANEL_IDS.bcf]: 'BCF',
  [BUILTIN_PANEL_IDS.ids]: 'IDS',
  [BUILTIN_PANEL_IDS.lens]: 'Lens',
  [BUILTIN_PANEL_IDS.extensions]: 'Extensions',
  [BUILTIN_PANEL_IDS.addElement]: 'Add element',
  [BUILTIN_PANEL_IDS.lists]: 'Lists',
  [BUILTIN_PANEL_IDS.script]: 'Script',
  [BUILTIN_PANEL_IDS.gantt]: 'Schedule',
};
