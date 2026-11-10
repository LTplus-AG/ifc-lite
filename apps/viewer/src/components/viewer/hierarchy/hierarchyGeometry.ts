/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { sharedMeshedIds } from '@/lib/object-count';

/**
 * Build the global-id set used by hierarchy geometry filters.
 *
 * Delegates to {@link sharedMeshedIds} (`collectMeshedIds`) — the single "which ids have
 * geometry" rule — rather than re-deriving it from `meshes` alone, which
 * used to drop every GPU-instanced-only entity (present only in
 * `instancedGeometryHashes`/`Aabbs`/`Volumes`) from the hierarchy trees while
 * the StatusBar counted it. A federated model's `geometryResult` ids are
 * already global (`originalExpressId + idOffset`, `store/types.ts`), and so
 * are the instanced-only side-channel keys (`useIfcLoader.ts` re-keys them by
 * `idOffset` on federation), so no local/global conversion is needed here —
 * `collectMeshedIds`'s default identity `toLocalId` is exactly right.
 */
export function buildGeometricIdSet(
  models: Map<string, FederatedModel>,
  legacyGeometry: GeometryResult | null | undefined,
): Set<number> {
  if (models.size > 0) {
    // One model: its shared meshed-id set as is (read-only), not a second scan (NEW-4).
    if (models.size === 1) {
      const only = models.values().next().value!.geometryResult;
      return only ? sharedMeshedIds(only) : new Set<number>();
    }
    const ids = new Set<number>();
    for (const model of models.values()) {
      if (model.geometryResult) for (const id of sharedMeshedIds(model.geometryResult)) ids.add(id);
    }
    return ids;
  }
  return legacyGeometry ? sharedMeshedIds(legacyGeometry) : new Set<number>();
}

/** Models whose geometry result exists, including completed zero-mesh models. */
export function collectGeometryReadyModelIds(
  models: Map<string, FederatedModel>,
  legacyGeometry: GeometryResult | null | undefined,
): Set<string> {
  const ready = new Set<string>();
  if (models.size > 0) {
    for (const [modelId, model] of models) {
      if (model.geometryResult) ready.add(modelId);
    }
  } else if (legacyGeometry) {
    ready.add('legacy');
  }
  return ready;
}

/** Global IDs of curve-only annotations rendered outside the mesh pipeline. */
export function collectAnnotationEntityIds(
  models: Map<string, FederatedModel>,
  legacyStore: IfcDataStore | null | undefined,
): Set<number> {
  const ids = new Set<number>();
  const addFrom = (store: IfcDataStore | null | undefined, toGlobal: (localId: number) => number) => {
    if (typeof store?.getEntitiesByType !== 'function') return;
    for (const entity of store.getEntitiesByType('IfcAnnotation')) {
      ids.add(toGlobal(entity.expressId));
    }
  };
  if (models.size > 0) {
    const state = useViewerStore.getState();
    for (const [modelId, model] of models) {
      addFrom(model.ifcDataStore, (localId) =>
        modelId === 'legacy' ? localId : state.toGlobalId(modelId, localId));
    }
  } else {
    addFrom(legacyStore, (localId) => localId);
  }
  return ids;
}
