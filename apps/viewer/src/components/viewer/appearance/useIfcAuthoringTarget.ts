/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useState } from 'react';
import { IfcTypeEnum, type SpatialNode } from '@ifc-lite/data';
import { useViewerStore } from '@/store';

/** Shared destination defaults for drawings and captured surfaces. */
export function useIfcAuthoringTarget() {
  const models = useViewerStore(state => state.models);
  const mutationViews = useViewerStore(state => state.mutationViews);
  const activeModel = useViewerStore(state => state.activeModelId);
  const activeStorey = useViewerStore(state => state.activeStorey);
  const eligible = [...models.values()].filter(model => model.ifcDataStore?.spatialHierarchy?.project && mutationViews.has(model.id) && model.schemaVersion.startsWith('IFC4'));
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
  return { modelId, containerId, eligible, containers, setChosenModel, setChosenContainer };
}
