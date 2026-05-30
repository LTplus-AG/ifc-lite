/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { EyeOff, GripVertical, Maximize2, Pencil } from 'lucide-react';
import {
  BUILTIN_PANEL_IDS,
  type WorkbenchPanelId,
  type WorkbenchZoneId,
} from '@ifc-lite/extensions';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { ViewportContainer } from '@/components/viewer/ViewportContainer';
import { ExtensionDockHost } from '@/components/extensions/ExtensionDockHost';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import {
  closeActiveAnalysisExtension,
  getAnalysisExtensionById,
  getAnalysisExtensionsSnapshot,
} from '@/services/analysis-extensions';
import { PersonalPanelDialog } from './PersonalPanelDialog';
import { PanelChromeDialog } from './PanelChromeDialog';
import { PanelLibraryDialog } from './PanelLibraryDialog';
import { MorphToolbar } from './MorphToolbar';
import { getWorkbenchPanelTitle, ZONE_LABEL } from './panelRegistry';
import { WorkbenchPanelHost } from './WorkbenchPanelHost';
import { WorkspaceModesDialog } from './WorkspaceModesDialog';
import { firePanelOpenedAutomation, useWorkbenchAutomations } from '@/hooks/useWorkbenchAutomations';
import { WorkbenchFloatingPanels } from './WorkbenchFloatingPanels';
import { WorkbenchPatchDialog } from './WorkbenchPatchDialog';
import { CustomizationStudioDialog } from './CustomizationStudioDialog';

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
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [modesOpen, setModesOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [editingPanelId, setEditingPanelId] = useState<string | null>(null);
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
  useWorkbenchAutomations();

  useEffect(() => {
    const openStudio = () => setStudioOpen(true);
    window.addEventListener('ifc-lite:open-customization-studio', openStudio);
    return () => window.removeEventListener('ifc-lite:open-customization-studio', openStudio);
  }, []);

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
        onLibrary={() => setLibraryOpen(true)}
        onModes={() => setModesOpen(true)}
        onStudio={() => setStudioOpen(true)}
        onReset={() => {
          resetLayout();
          toast.success('Layout reset to IFC Lite default.');
        }}
      />
      <div className="flex-1 min-h-0">
        <PanelGroup
          orientation="horizontal"
          className="h-full"
          onLayoutChanged={(sizes) => {
            const left = sizes['left-panel'];
            const viewport = sizes['viewport-panel'];
            const right = sizes['right-panel'];
            if (left !== undefined && viewport !== undefined && right !== undefined) {
              setSizes([left, viewport, right]);
            }
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
      <PanelLibraryDialog
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onEdit={(panelId) => {
          setLibraryOpen(false);
          setEditingPanelId(panelId);
        }}
      />
      <PanelChromeDialog panelId={editingPanelId} onClose={() => setEditingPanelId(null)} />
      <WorkspaceModesDialog open={modesOpen} onClose={() => setModesOpen(false)} />
      <CustomizationStudioDialog open={studioOpen} onClose={() => setStudioOpen(false)} />
      <WorkbenchFloatingPanels />
      <WorkbenchPatchDialog />
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
              onClick={() => {
                setActive(zone, panelId);
                firePanelOpenedAutomation(panelId);
              }}
            />
          ))}
          {morphMode && (
            <div className="ml-auto px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {ZONE_LABEL[zone]}
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {activePanel ? <WorkbenchPanelHost panelId={activePanel} zone={zone} /> : <EmptyZone zone={zone} />}
        </div>
        {zone !== 'bottom' && <ExtensionDockHost slot={zone === 'left' ? 'dock.left' : 'dock.right'} className="max-h-[35%] border-t" />}
      </div>
    </DropZone>
  );
}

function PanelTab({
  panelId,
  active,
  morphMode,
  onClick,
}: {
  panelId: string;
  active: boolean;
  morphMode: boolean;
  onClick: () => void;
}) {
  const title = usePanelTitle(panelId);
  const setChrome = useViewerStore((s) => s.setWorkbenchPanelChrome);
  const setFloating = useViewerStore((s) => s.setWorkbenchFloatingPanel);
  const [editingPanelId, setEditingPanelId] = useWorkbenchPanelEditor();
  return (
    <div
      draggable={morphMode}
      onDragStart={(event) => event.dataTransfer.setData('application/x-ifc-lite-panel', panelId)}
      className={cn(
        'shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs border-b-2 transition-colors',
        active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
      title={morphMode ? `Drag ${title} to another dock` : title}
    >
      <button type="button" className="flex items-center gap-1" onClick={onClick}>
        {morphMode && <GripVertical className="h-3 w-3" />}
        {title}
      </button>
      {morphMode && (
        <>
          <button
            type="button"
            className="ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Edit ${title}`}
            onClick={() => setEditingPanelId(panelId)}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Float ${title}`}
            onClick={() => {
              setFloating({ panelId, x: 96, y: 96, width: 420, height: 520 });
              setChrome(panelId, { hidden: true });
            }}
          >
            <Maximize2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Hide ${title}`}
            onClick={() => setChrome(panelId, { hidden: true })}
          >
            <EyeOff className="h-3 w-3" />
          </button>
        </>
      )}
      <PanelChromeDialog panelId={editingPanelId} onClose={() => setEditingPanelId(null)} />
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

function usePanelTitle(panelId: string): string {
  return useViewerStore((s) => {
    return getWorkbenchPanelTitle(s.workbenchLayout, panelId);
  });
}

function useWorkbenchPanelEditor(): [string | null, (panelId: string | null) => void] {
  return useState<string | null>(null);
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


