/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { BUILTIN_PANEL_IDS, validateWidget, type PanelContribution, type SlotContribution, type WorkbenchZoneId } from '@ifc-lite/extensions';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import { WidgetRenderer, type WidgetRendererContext } from '@/components/extensions/widget/WidgetRenderer';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { parseExtensionPanelWorkbenchId } from './panelRegistry';

export function WorkbenchPanelHost({ panelId, zone }: { panelId: string; zone: WorkbenchZoneId }) {
  const closePanel = useClosePanel(panelId, zone);
  const personal = useViewerStore((s) => s.workbenchLayout.personalPanels[panelId]);
  const extensionPanels = useSlotContributions<PanelContribution>('workbench.panels');
  const ctx = usePersonalWidgetContext();
  if (personal) {
    return (
      <ScrollArea className="h-full">
        <div className="p-3">
          <WidgetRenderer node={personal.widget as unknown as Parameters<typeof WidgetRenderer>[0]['node']} ctx={ctx} />
        </div>
      </ScrollArea>
    );
  }
  const parsedExtensionPanel = parseExtensionPanelWorkbenchId(panelId);
  if (parsedExtensionPanel) {
    const contribution = extensionPanels.find((entry) =>
      entry.extensionId === parsedExtensionPanel.extensionId
      && entry.payload.id === parsedExtensionPanel.panelId,
    );
    return contribution ? <ExtensionWorkbenchPanel contribution={contribution} ctx={ctx} /> : <EmptyPanel panelId={panelId} />;
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

function ExtensionWorkbenchPanel({
  contribution,
  ctx,
}: {
  contribution: SlotContribution<PanelContribution>;
  ctx: WidgetRendererContext;
}) {
  const host = useOptionalExtensionHost();
  const [state, setState] = useState<{ widget?: Parameters<typeof WidgetRenderer>[0]['node']; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    try {
      const bundle = host?.loader.getBundle(contribution.extensionId);
      const file = bundle?.files.get(contribution.payload.widget);
      if (!file) {
        setState({ error: `Widget ${contribution.payload.widget} not found.` });
        return;
      }
      const text = file.text ?? new TextDecoder().decode(file.bytes);
      const json = JSON.parse(text);
      const validated = validateWidget(json, contribution.payload.widget);
      if (!validated.ok) {
        const first = validated.errors[0];
        setState({ error: `${first?.path ?? 'widget'} ${first?.message ?? 'failed validation'}` });
        return;
      }
      if (!cancelled) setState({ widget: validated.value });
    } catch (err) {
      if (!cancelled) setState({ error: err instanceof Error ? err.message : String(err) });
    }
    return () => { cancelled = true; };
  }, [contribution, host]);

  if (state.error) return <div className="p-3 text-xs text-destructive">{state.error}</div>;
  if (!state.widget) return <div className="p-3 text-xs text-muted-foreground">Loading extension panel...</div>;
  return (
    <ScrollArea className="h-full">
      <div className="p-3">
        <WidgetRenderer node={state.widget} ctx={ctx} />
      </div>
    </ScrollArea>
  );
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

function usePersonalWidgetContext(): WidgetRendererContext {
  const host = useOptionalExtensionHost();
  return useMemo(() => ({
    state: {},
    invokeCommand: (commandId: string) => {
      host?.runCommand(commandId).catch((err) => {
        console.warn('[WorkbenchPanelHost] personal panel command failed:', err);
      });
    },
  }), [host]);
}

function EmptyPanel({ panelId }: { panelId: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
      <X className="mr-2 h-4 w-4" />
      Panel unavailable: {panelId}
    </div>
  );
}
