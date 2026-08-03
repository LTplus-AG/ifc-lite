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
 * The `aabb` rides alongside it on `MeshData.geometryAabb`, from the same WASM
 * pass (#1891). It is ABSOLUTE world in the renderer's Y-up frame — RTC and the
 * per-element `origin` already folded in on the Rust side — which is what makes
 * it comparable across two revisions that chose different RTC offsets, the
 * frame contract `EntityFingerprint.aabb` demands. Do not add `origin` to it,
 * and do not substitute a box folded from `MeshData.positions`: those are
 * RTC- and origin-relative and would report a moved element as stationary.
 *
 * A federated model whose vertices were re-baked into the anchor's frame has
 * had its boxes re-framed with them (`hooks/ingest/federationAlignAabb.ts`),
 * so both sides of a compare are read in one frame no matter which of them
 * the federation anchored on.
 *
 * The proved enclosed volume (#1993) rides on `MeshData.geometryVolume` from
 * that same pass, and is the one fingerprint that does NOT survive that trip:
 * the alignment rescales, and no re-measurement is available on this side. It
 * is therefore withheld for a re-baked model rather than re-derived — see
 * `geometryVolumesSurviveAlignment`.
 *
 * Scope: only entities that produced at least one mesh are fingerprinted —
 * the engine needs a geometry hash to detect geometry changes, and the
 * compare UI colours meshed elements in 3D. Data-only edits on those meshed
 * entities are still detected via the data hash.
 */

import {
  buildComponentFingerprints,
  buildDataFingerprint,
  type DataFingerprintInput,
  type EntityFingerprint,
} from '@ifc-lite/diff';
import { RelationshipType } from '@ifc-lite/data';
import {
  extractAllEntityAttributes,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import type { EntityWorldAabb, MeshData } from '@ifc-lite/geometry';
import { isGeometricDataName } from './geometricData.js';
import type { FederatedModel } from '@/store/types';

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
  /**
   * Geometry-diff hashes for instanced-ONLY entities (#924) — repeated opaque
   * geometry that GPU-instancing took off the flat `meshes` array, so it carries
   * no per-mesh `geometryHash`. Keyed by express id (same convention as
   * `meshes`). Without this, compare would silently miss geometry changes on
   * instanced elements. Instancing is primary-model only, so these ids have
   * `idOffset === 0`.
   */
  instancedGeometryHashes?: ReadonlyMap<number, bigint>;
  /**
   * World boxes for those same instanced-ONLY entities (#1891). Without them
   * the diff's positional tiers stay dark for exactly the repeated components
   * they exist to pair — instancing removes an element from `meshes` precisely
   * when it is one of many identical copies. Keyed by express id, like
   * {@link instancedGeometryHashes}; a hashed entity may legitimately be absent
   * here (the pass produced no box for it).
   */
  instancedGeometryAabbs?: ReadonlyMap<number, EntityWorldAabb>;
  /**
   * Proved enclosed volumes (m³) for those same instanced-ONLY entities
   * (#1993), keyed by express id. Folded in for the same reason as the boxes:
   * a precast slab field is exactly the repeated geometry instancing removes
   * from `meshes`, and exactly the population the split/merge detector exists
   * for. A hashed entity is legitimately absent here whenever the kernel could
   * not prove a volume for it.
   */
  instancedGeometryVolumes?: ReadonlyMap<number, number>;
  /**
   * May this model's `geometryVolume`s be believed? Default `true`.
   *
   * Federation alignment re-bakes a model's vertices into the anchor's frame,
   * and that map carries a SCALE (`IfcMapConversion.Scale` plus the map-unit
   * factor), so a volume measured before it describes geometry at a size that
   * no longer exists. The box survives because `federationAlignAabb.ts`
   * re-measures it from the aligned vertices; a volume cannot be re-measured
   * here — the closure proof that licensed it lives in the kernel, on
   * unaligned geometry, and is not reconstructible from submesh triangles.
   *
   * So the caller passes `false` for an aligned model and the volumes are
   * simply not attached. Absent is the engine's "not proved", which is exactly
   * true here, and the split/merge detector degrades to its extent tier rather
   * than comparing a pre-alignment volume against a post-alignment one. The
   * hash and the box are unaffected: neither changes meaning under a rescale
   * that has already been applied to both sides of what they describe.
   */
  geometryVolumesTrusted?: boolean;
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
  const {
    store,
    meshes,
    instancedGeometryHashes,
    instancedGeometryAabbs,
    instancedGeometryVolumes,
    idOffset,
    modelId,
  } = model;
  // Opt-OUT, not opt-in: every caller that has not thought about federation
  // alignment is a caller whose model was never re-baked, and defaulting to
  // "believe them" keeps the flag a statement about the one case that needs it.
  const volumesTrusted = model.geometryVolumesTrusted !== false;

  // local express id → first geometry hash seen for it (may be undefined when
  // hashing was disabled or the WASM build predates it — data diff still works)
  const geometryByLocalId = new Map<number, bigint | undefined>();
  // local express id → the entity's absolute world box (#1891). No
  // first-wins arbitration like the hash needs: the box is per ENTITY, so every
  // submesh of one entity carries the identical object off a single wasm pass
  // and there is nothing for two submeshes to disagree about.
  const aabbByLocalId = new Map<number, EntityWorldAabb>();
  // local express id → proved enclosed volume (#1993). Per ENTITY like the box,
  // so no arbitration between submeshes — and emphatically NOT a sum over them:
  // every submesh of one entity carries the identical whole-entity value, so
  // adding them up would report a k-submesh element at k times its volume.
  const volumeByLocalId = new Map<number, number>();
  for (const mesh of meshes) {
    const localId = mesh.expressId - idOffset;
    if (!geometryByLocalId.has(localId)) {
      geometryByLocalId.set(localId, mesh.geometryHash);
    } else if (geometryByLocalId.get(localId) === undefined && mesh.geometryHash !== undefined) {
      geometryByLocalId.set(localId, mesh.geometryHash);
    }
    if (mesh.geometryAabb) aabbByLocalId.set(localId, mesh.geometryAabb);
    if (volumesTrusted && mesh.geometryVolume !== undefined) {
      volumeByLocalId.set(localId, mesh.geometryVolume);
    }
  }
  // Fold in instanced-only entities (#924): repeated opaque geometry GPU-instancing
  // took off the flat `meshes` array. They have no MeshData, so they'd be absent
  // from compare entirely — add them here so geometry changes are still detected.
  // A real flat-mesh hash always wins (set first above); only fill gaps.
  if (instancedGeometryHashes) {
    for (const [expressId, hash] of instancedGeometryHashes) {
      const localId = expressId - idOffset;
      if (geometryByLocalId.get(localId) === undefined) {
        geometryByLocalId.set(localId, hash);
      }
    }
  }
  // Their boxes need the same fold, and for the same reason squared: a
  // GPU-instanced element is by definition one of several identical copies, so
  // it is the population tier 3's mutual-nearest pairing was written for. Fill
  // gaps only, so a flat mesh's box (measured on this very load) always wins.
  if (instancedGeometryAabbs) {
    for (const [expressId, aabb] of instancedGeometryAabbs) {
      const localId = expressId - idOffset;
      if (!aabbByLocalId.has(localId)) aabbByLocalId.set(localId, aabb);
    }
  }
  // And their volumes, gap-filling on the same rule.
  if (volumesTrusted && instancedGeometryVolumes) {
    for (const [expressId, volume] of instancedGeometryVolumes) {
      const localId = expressId - idOffset;
      if (!volumeByLocalId.has(localId)) volumeByLocalId.set(localId, volume);
    }
  }

  const fingerprints: EntityFingerprint<CompareRef>[] = [];
  let processed = 0;
  for (const [localId, geometryHash] of geometryByLocalId) {
    const ifcType = store.entities.getTypeName(localId) || 'IfcProduct';
    const globalId = store.entities.getGlobalId(localId);
    const key = globalId || `missing:${modelId}:${localId}`;

    // One extraction, two fingerprints. `components` is the collision guard on
    // content matching's destructive path (#1891): retiring a real add+delete
    // in favour of one match record rests on `dataHash` equality meaning
    // identity, and per-component sub-hashes catch a colliding pset/qset that
    // the 64-bit data hash cannot. Both are computed from the SAME input
    // object - a sub-hash over a different projection would stop being a
    // collision guard and start rejecting genuine re-export matches.
    const dataInput = buildDataInput(store, localId, ifcType);

    // The box goes on ONLY when the pass produced one: the engine's contract is
    // that a missing box is `undefined`, and a NaN-bearing object would pass
    // `aabb !== undefined` while classifying every comparison as garbage. The
    // NaN sentinel is already resolved at the wasm boundary
    // (`extractGeometryFingerprints`), so anything reaching here is real.
    const aabb = aabbByLocalId.get(localId);
    // Same rule for the volume, and the same reason: `NaN` was resolved to
    // absent at the wasm boundary, so a number reaching here is a proved one.
    const volume = volumeByLocalId.get(localId);

    fingerprints.push({
      key,
      ifcType,
      dataHash: buildDataFingerprint(dataInput),
      components: buildComponentFingerprints(dataInput),
      geometryHash,
      ...(aabb ? { aabb } : {}),
      ...(volume !== undefined ? { volume } : {}),
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

/**
 * Do a model's proved volumes (#1993) still describe its geometry after
 * federation alignment put it where it now is?
 *
 * `'same-crs'` and `'reprojected'` re-bake every vertex through a map that
 * carries a SCALE, so a volume measured before it is a volume of geometry at a
 * size that is no longer on screen — and unlike the world box, it cannot be
 * re-measured on this side (see {@link BuildFingerprintsModel.geometryVolumesTrusted}).
 * Every other status left the vertices alone: `'anchor'` and `'none'` never
 * transformed anything, `'identity'` computed a transform and found nothing to
 * apply, and `'failed'` gave up before applying one.
 *
 * An unset status is a model that predates federation entirely — trusted.
 */
export function geometryVolumesSurviveAlignment(
  status: FederatedModel['federationAlignmentStatus'],
): boolean {
  return status !== 'same-crs' && status !== 'reprojected';
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
  // (see geometricData.ts).
  const propertySets = extractPropertiesOnDemand(store, localId)
    .filter((set) => !isGeometricDataName(set.name))
    .map((set) => ({
      name: set.name,
      properties: set.properties
        .filter((property) => !isGeometricDataName(property.name))
        .map((property) => ({ name: property.name, value: property.value })),
    }))
    .filter((set) => set.properties.length > 0);

  // Quantities (Volume/Area/Length/…) ARE part of the data story: adding or
  // removing a quantity set, or editing a quantity, is a real change a
  // coordinator needs to see (#1198 — they were previously excluded wholesale
  // and so never reported). They're geometry-*derived*, so a reshape also
  // recomputes them and reads as "data · geometry" — that's correct, the
  // numbers genuinely changed. A pure translation leaves Volume/Area/Length
  // untouched, so it stays a geometry-only change. Values are rounded to the
  // panel's display precision so re-export float noise can't fabricate a diff.
  const quantitySets = extractQuantitiesOnDemand(store, localId)
    .filter((set) => !isGeometricDataName(set.name))
    .map((set) => ({
      name: set.name,
      quantities: set.quantities
        .filter((quantity) => !isGeometricDataName(quantity.name))
        .map((quantity) => ({ name: quantity.name, value: roundQuantity(quantity.value) })),
    }))
    .filter((set) => set.quantities.length > 0);

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
    quantitySets,
    typeAssignments,
  };
}

/** Round a geometry-derived quantity to the compare panel's display precision
 *  (4 dp) so re-exporting a model with sub-tolerance float jitter doesn't flip
 *  the data hash on an otherwise-identical element. */
function roundQuantity(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value;
}
