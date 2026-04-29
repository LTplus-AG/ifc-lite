/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve a `SpatialAnchor` from a parsed `IfcDataStore`.
 *
 * Walks the entity index for the IfcOwnerHistory, the 'Body'
 * IfcGeometricRepresentationSubContext (falling back to the model's
 * 3D IfcGeometricRepresentationContext), and the target storey's
 * IfcLocalPlacement.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { SpatialAnchor } from './anchor.js';

export function resolveSpatialAnchor(store: IfcDataStore, storeyExpressId: number): SpatialAnchor {
  const ownerHistoryId = findOwnerHistoryId(store);
  if (ownerHistoryId === null) {
    throw new Error('resolveSpatialAnchor: no IfcOwnerHistory found in store');
  }

  const bodyContextId = findBodyContextId(store);
  if (bodyContextId === null) {
    throw new Error('resolveSpatialAnchor: no IfcGeometricRepresentationContext (or Body subcontext) found in store');
  }

  const storeyPlacementId = findStoreyPlacementId(store, storeyExpressId);
  if (storeyPlacementId === null) {
    throw new Error(`resolveSpatialAnchor: storey #${storeyExpressId} has no resolvable IfcLocalPlacement`);
  }

  return { ownerHistoryId, bodyContextId, storeyId: storeyExpressId, storeyPlacementId };
}

function findOwnerHistoryId(store: IfcDataStore): number | null {
  const ids = store.entityIndex.byType.get('IFCOWNERHISTORY');
  return ids && ids.length > 0 ? ids[0] : null;
}

/**
 * Prefer an IfcGeometricRepresentationSubContext with ContextIdentifier='Body';
 * otherwise fall back to the first 3D IfcGeometricRepresentationContext.
 */
function findBodyContextId(store: IfcDataStore): number | null {
  if (!store.source) return null;
  const extractor = new EntityExtractor(store.source);

  const subIds = store.entityIndex.byType.get('IFCGEOMETRICREPRESENTATIONSUBCONTEXT') ?? [];
  for (const id of subIds) {
    const ref = store.entityIndex.byId.get(id);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
    const identifier = entity?.attributes?.[0];
    if (typeof identifier === 'string' && identifier.toLowerCase() === 'body') {
      return id;
    }
  }

  const ctxIds = store.entityIndex.byType.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [];
  for (const id of ctxIds) {
    const ref = store.entityIndex.byId.get(id);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
    const dimension = entity?.attributes?.[2];
    if (typeof dimension === 'number' && dimension === 3) {
      return id;
    }
  }
  return ctxIds[0] ?? null;
}

/**
 * Resolve the target storey's `ObjectPlacement` (an IfcLocalPlacement).
 * On IfcBuildingStorey the ObjectPlacement is positional attribute index 5
 * (inherited from IfcProduct).
 */
function findStoreyPlacementId(store: IfcDataStore, storeyExpressId: number): number | null {
  if (!store.source) return null;
  const ref = store.entityIndex.byId.get(storeyExpressId);
  if (!ref) return null;
  const extractor = new EntityExtractor(store.source);
  const entity = extractor.extractEntity(ref);
  const placement = entity?.attributes?.[5];
  return typeof placement === 'number' ? placement : null;
}
