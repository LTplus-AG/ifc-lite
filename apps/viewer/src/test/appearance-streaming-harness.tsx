/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useRef } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useGeometryStreaming } from '@/components/viewer/useGeometryStreaming';
import { modelIndices } from '@/lib/model-placement/model-indices';
const noop = () => {};
/** Mount the actual viewport reconciler alongside native authoring UI. */
export function AppearanceStreamingHarness({ renderer }: { renderer: Renderer }) {
  const models = useViewerStore(state => state.models);
  const geometry = models.get('evaluated')!.geometryResult!;
  const rendererRef = useRef<Renderer | null>(renderer);
  const geometryBoundsRef = useRef({ min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } });
  const clearColorRef = useRef<[number, number, number, number]>([0,0,0,1]);
  useGeometryStreaming({ rendererRef, geometry: geometry.meshes, coordinateInfo: geometry.coordinateInfo,
    modelCount: models.size, presentInstancedModelIndices: new Set(modelIndices(models).values()),
    isInitialized: true, isStreaming: false, geometryBoundsRef, clearColorRef,
    pendingMeshColorUpdates: null, pendingColorUpdates: null, pendingMeshRemovals: null,
    pendingMeshTranslations: null, pendingMeshRotations: null, pendingInstancedShards: null,
    clearPendingMeshColorUpdates: noop, clearPendingColorUpdates: noop, clearPendingMeshRemovals: noop,
    clearPendingMeshTranslations: noop, clearPendingMeshRotations: noop, clearInstancedShards: noop });
  return null;
}
