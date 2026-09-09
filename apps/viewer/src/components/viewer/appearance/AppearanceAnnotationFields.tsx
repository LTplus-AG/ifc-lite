/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { IfcTypeEnum, type SpatialNode } from '@ifc-lite/data';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { createAnnotationFromReference } from '@/lib/appearance/create-annotation';
import { appearanceSelectClass } from './AppearanceSourceFields';

/** Explicit IFC creation, next to the independent drawing it captures. */
export function AppearanceAnnotationFields({ referenceId, name, disabled }: {
  referenceId: string; name: string; disabled: boolean;
}) {
  const models = useViewerStore(state => state.models);
  const activeModel = useViewerStore(state => state.activeModelId);
  const activeStorey = useViewerStore(state => state.activeStorey);
  const room = useViewerStore(state => state.collabRoomId);
  const eligible = [...models.values()].filter(model => model.ifcDataStore && model.schemaVersion.startsWith('IFC4'));
  const [chosenModel, setChosenModel] = useState(activeModel ?? '');
  const modelId = eligible.some(model => model.id === chosenModel) ? chosenModel : eligible[0]?.id ?? '';
  const model = models.get(modelId);
  const containers: SpatialNode[] = [];
  const pendingNodes = model?.ifcDataStore?.spatialHierarchy?.project ? [model.ifcDataStore.spatialHierarchy.project] : [];
  const visited = new Set<number>();
  while (pendingNodes.length) {
    const node = pendingNodes.pop()!;
    if (visited.has(node.expressId)) continue;
    visited.add(node.expressId);
    if (node.type !== IfcTypeEnum.IfcProject) containers.push(node);
    pendingNodes.push(...node.children.slice().reverse());
  }
  const [chosenContainer, setChosenContainer] = useState<number | undefined>();
  const preferred = activeStorey?.modelId === modelId ? activeStorey.expressId : undefined;
  const containerId = containers.find(node => node.expressId === chosenContainer)?.expressId
    ?? containers.find(node => node.expressId === preferred)?.expressId
    ?? containers.find(node => node.type === IfcTypeEnum.IfcBuildingStorey)?.expressId ?? containers[0]?.expressId;
  const [Name, setName] = useState(name);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; }, []);
  useEffect(() => {
    if (disabled) operation.current?.abort();
  }, [disabled]);
  async function save() {
    if (disabled || room || operation.current || containerId === undefined || !modelId) return;
    const renderer = getGlobalRenderer();
    if (!renderer) { setError(true); setMessage('Wait for the 3D view to be ready.'); return; }
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(false); setMessage('Creating textured annotation…');
    try {
      const result = await createAnnotationFromReference(modelId, containerId, referenceId, renderer, { Name, signal: controller.signal });
      if (controller.signal.aborted) return;
      const state = useViewerStore.getState();
      state.selectAppearanceReference(null);
      state.setSelectedEntityId(result.globalId);
      state.setSelectedEntity({ modelId, expressId: result.expressId });
      setMessage('Textured IfcAnnotation created and selected. Undo is available.');
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(true); setMessage(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(false); }
    }
  }
  return <details className="mt-2 border-t pt-2">
    <summary className="cursor-pointer text-[11px] font-medium">Save into model</summary>
    <div className="mt-2 space-y-2" aria-busy={busy}>
      <p className="text-[11px] text-muted-foreground">Create a textured IfcAnnotation at this drawing’s position. The workspace reference remains available.</p>
      <fieldset disabled={disabled || busy || !!room} className="space-y-2">
        <label className="block text-[11px]">Model<select aria-label="Annotation model" className={appearanceSelectClass} value={modelId}
          onChange={event => { setChosenModel(event.target.value); setChosenContainer(undefined); setMessage(''); }}>
          {!eligible.length && <option value="">Load an editable IFC4 model</option>}
          {eligible.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="block text-[11px]">Container<select aria-label="Annotation container" className={appearanceSelectClass} value={containerId ?? ''}
          onChange={event => setChosenContainer(Number(event.target.value))}>
          {!containers.length && <option value="">No spatial container available</option>}
          {containers.map(node => <option key={node.expressId} value={node.expressId}>{node.name || `#${node.expressId}`}</option>)}
        </select></label>
        <label className="block text-[11px]">Name<Input aria-label="Annotation Name" value={Name} onChange={event => setName(event.target.value)} className="h-8 text-xs" /></label>
        <Button type="button" variant="outline" size="sm" disabled={!modelId || containerId === undefined || !Name.trim()} onClick={() => { void save(); }}>Create annotation</Button>
      </fieldset>
      {room && <p className="text-[11px] text-muted-foreground">Leave the shared room to create an annotation, then share the saved model.</p>}
      {busy && <Button type="button" variant="ghost" size="sm" onClick={() => { operation.current?.abort(); setMessage('Annotation creation cancelled.'); }}>Cancel creation</Button>}
      {message && <p role={error ? 'alert' : 'status'} className={`text-[11px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</p>}
    </div>
  </details>;
}
