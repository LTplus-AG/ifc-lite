/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { parseFederatedIfcx } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { layerStackEntry } from '@/lib/layers/stack.js';
import { toast } from '@/components/ui/toast.js';

type Composition = Awaited<ReturnType<typeof parseFederatedIfcx>>;

/** Publish layer presentation only after the canonical model finalizer succeeds. */
export function publishIfcxLayers(modelId: string, stack: Composition['layerStack'], pathToId?: Map<string, number>) {
  const state = useViewerStore.getState();
  const owner = state.models.get(modelId);
  if (!owner?.geometryResult || !owner.ifcDataStore) return;
  const layers = stack.getLayers();
  state.setLayerStack([...layers].reverse().map(layerStackEntry), pathToId ?? null);
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (i === layers.length - 1) {
      const basePatch = { name: layer.name, fileSize: layer.buffer.byteLength, _isOverlay: false, _layerIndex: i };
      state.updateModel(modelId, basePatch);
      continue;
    }
    const overlay: FederatedModel & { _isOverlay: boolean; _layerIndex: number } = {
      id: layer.id, name: layer.name, ifcDataStore: owner.ifcDataStore,
      geometryResult: { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: owner.geometryResult.coordinateInfo },
      visible: true, collapsed: i > 0, schemaVersion: 'IFC5', loadedAt: layer.loadedAt,
      fileSize: layer.buffer.byteLength, idOffset: owner.idOffset, maxExpressId: 0,
      _isOverlay: true, _layerIndex: i,
    };
    state.addModel(overlay);
  }
  // Match the existing strongest-first Models presentation; the finalized base
  // remains the active owner of geometry and its registered entity range.
  const models = useViewerStore.getState().models;
  const entries: Array<[string, FederatedModel]> = layers.map((layer, index) => {
    const id = index === layers.length - 1 ? modelId : layer.id;
    return [id, models.get(id)!];
  });
  const ownIds = new Set(entries.map(([id]) => id));
  useViewerStore.setState({ models: new Map([...models].filter(([id]) => !ownIds.has(id)).concat(entries)) });
  if (layers.length >= 2 && typeof window !== 'undefined') {
    try {
      const key = 'ifc-lite:layers:intro-shown';
      if (!window.localStorage.getItem(key)) {
        window.localStorage.setItem(key, '1');
        state.openWorkspacePanel('layers', 'programmatic');
        toast.info(`Composed ${layers.length} layers - inspect, diff, publish, and merge them in the Layers panel.`);
      }
    } catch (error) {
      console.warn('[useIfc] Cannot retain Layers panel introduction preference:', error);
    }
  }
}
