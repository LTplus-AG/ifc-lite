/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer adapter for the `@ifc-lite/diff` engine (issue #924).
 *
 * Turns a loaded model — its `IfcDataStore` plus the tessellated meshes from
 * the geometry pass — into the per-entity {@link EntityFingerprint}s the
 * store-agnostic engine matches and classifies. This is the viewer's
 * counterpart to the CLI adapter; the canonical data fingerprint comes from
 * `@ifc-lite/diff`'s {@link buildDataFingerprint} (the same hash the threejs
 * compare example pioneered) and the geometry fingerprint is the RTC-invariant
 * WASM hash riding on each `MeshData.geometryHash`.
 *
 * Scope: only entities that produced at least one mesh are fingerprinted —
 * the engine needs a geometry hash to detect geometry changes, and the
 * compare UI colours meshed elements in 3D. Data-only edits on those meshed
 * entities are still detected via the data hash.
 */

import {
  buildDataFingerprint,
  type DataFingerprintInput,
  type EntityFingerprint,
} from '@ifc-lite/diff';
import { RelationshipType } from '@ifc-lite/data';
import {
  extractAllEntityAttributes,
  extractPropertiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { isGeometricDataName } from './geometricData.js';

/**
 * Adapter handle threaded through the diff onto each {@link CompareDiffEntry}.
 * Carries everything the compare UI needs downstream without re-deriving it:
 * `globalId` colours the entity in the federated renderer, while `modelId` +
 * `localId` drive selection / property lookup.
 */
export interface CompareRef {
  /** Federation model id this entity belongs to. */
  modelId: string;
  /** Original (pre-offset) express id — the key for `IfcDataStore` lookups. */
  localId: number;
  /** Federation global id (`localId + idOffset`) — the renderer mesh id. */
  globalId: number;
}

export interface BuildFingerprintsModel {
  /** Federation model id. */
  modelId: string;
  /** Parsed data store (local express ids). */
  store: IfcDataStore;
  /** Tessellated meshes. Express ids are federation-global (`local + idOffset`). */
  meshes: readonly MeshData[];
  /** This model's federation id offset (0 for the anchor / single-model load). */
  idOffset: number;
}

/**
 * Build one {@link EntityFingerprint} per meshed entity in a model.
 *
 * Entities are de-duplicated by express id (an entity emits several
 * submeshes); the first mesh carrying a `geometryHash` wins (all submeshes of
 * an entity share the whole-entity hash). The fingerprint `key` is the IFC
 * `GlobalId` so the engine matches the same element across revisions; entities
 * without a resolvable GlobalId fall back to a per-model synthetic key so they
 * never collide across A/B and simply read as added/deleted.
 */
export async function buildEntityFingerprints(
  model: BuildFingerprintsModel,
): Promise<EntityFingerprint<CompareRef>[]> {
  const { store, meshes, idOffset, modelId } = model;

  // local express id → first geometry hash seen for it (may be undefined when
  // hashing was disabled or the WASM build predates it — data diff still works)
  const geometryByLocalId = new Map<number, bigint | undefined>();
  for (const mesh of meshes) {
    const localId = mesh.expressId - idOffset;
    if (!geometryByLocalId.has(localId)) {
      geometryByLocalId.set(localId, mesh.geometryHash);
    } else if (geometryByLocalId.get(localId) === undefined && mesh.geometryHash !== undefined) {
      geometryByLocalId.set(localId, mesh.geometryHash);
    }
  }

  const fingerprints: EntityFingerprint<CompareRef>[] = [];
  let processed = 0;
  for (const [localId, geometryHash] of geometryByLocalId) {
    const ifcType = store.entities.getTypeName(localId) || 'IfcProduct';
    const globalId = store.entities.getGlobalId(localId);
    const key = globalId || `missing:${modelId}:${localId}`;

    fingerprints.push({
      key,
      ifcType,
      dataHash: buildDataFingerprint(buildDataInput(store, localId, ifcType)),
      geometryHash,
      ref: { modelId, localId, globalId: localId + idOffset },
    });

    // Per-entity property extraction reparses from the source buffer, so on a
    // large model this loop is heavy; yield to the main thread periodically so
    // the viewport stays responsive and the "Comparing…" spinner keeps
    // animating instead of the UI freezing (#924).
    if (++processed % 1500 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return fingerprints;
}

/** Does this side carry at least one usable geometry hash? Compares run on
 *  models loaded outside the WASM mesh path (e.g. huge native desktop loads)
 *  produce no hashes, which would make geometry diffs silently read every
 *  element as unchanged — callers warn when this is false. */
export function hasGeometryHashes(side: readonly EntityFingerprint<CompareRef>[]): boolean {
  return side.some((fingerprint) => fingerprint.geometryHash !== undefined);
}

/**
 * Assemble the canonical {@link DataFingerprintInput} for one entity from the
 * store's on-demand extractors. Mirrors the extraction in
 * `examples/threejs-viewer/src/compare.ts`; `@ifc-lite/diff` does the sorting
 * + hashing so base and head produce byte-identical hashes for an unchanged
 * entity.
 */
function buildDataInput(
  store: IfcDataStore,
  localId: number,
  ifcType: string,
): DataFingerprintInput {
  const predefinedType = extractAllEntityAttributes(store, localId).find(
    (attribute) => attribute.name === 'PredefinedType',
  )?.value;

  // Data vs geometry: placement/coordinate data (elevation, level offsets, …)
  // is owned by the geometry hash, so strip it from the data fingerprint — a
  // pure move must read as a geometry change only, never "data · geometry"
  // (see geometricData.ts). Quantities (Volume/Area/Length/…) are
  // geometry-derived measurements and are excluded wholesale for the same
  // reason: a reshape already shows up as a geometry change.
  const propertySets = extractPropertiesOnDemand(store, localId)
    .filter((set) => !isGeometricDataName(set.name))
    .map((set) => ({
      name: set.name,
      properties: set.properties
        .filter((property) => !isGeometricDataName(property.name))
        .map((property) => ({ name: property.name, value: property.value })),
    }))
    .filter((set) => set.properties.length > 0);

  const typeAssignments = store.relationships
    .getRelated(localId, RelationshipType.DefinesByType, 'inverse')
    .map((typeId) => ({
      globalId: store.entities.getGlobalId(typeId) || undefined,
      name: store.entities.getName(typeId) || undefined,
      type: store.entities.getTypeName(typeId) || undefined,
    }));

  return {
    ifcType,
    name: store.entities.getName(localId) || undefined,
    description: store.entities.getDescription(localId) || undefined,
    objectType: store.entities.getObjectType(localId) || undefined,
    predefinedType: predefinedType != null ? String(predefinedType) : undefined,
    propertySets,
    typeAssignments,
  };
}
