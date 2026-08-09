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
 * Scope: every entity that produced at least one mesh, PLUS every `IfcProduct`
 * with a GlobalId — see `compareScope.ts` for why that second half exists and
 * where its line is drawn. The mesh-only enumeration this widens made "did it
 * change?" quietly mean "did a renderable thing change?", so a geometry-less
 * `IfcElementAssembly` could have its attributes rewritten, and a geometry-less
 * `IfcSite` could be deleted outright, with the panel reporting neither.
 * Data-only edits on meshed entities were, and remain, detected via the data
 * hash.
 *
 * A product with no mesh carries, in place of a WASM geometry hash, a
 * fingerprint of its COMPOSED WORLD PLACEMENT (`worldPlacement.ts`). Leaving it
 * with no geometry hash at all made the whole geometry channel silent for that
 * population, and an entire re-georeferenced `IfcSite` — moved 40 m, turned 60
 * degrees, subtree and all — was reported as unchanged. It must be the composed
 * transform rather than the local placement: re-georeferencing rewrites the
 * placement *expression* of objects that did not move, and flagging those cries
 * wolf on every corrected model.
 *
 * The data fingerprint also carries the entity's RESOLVED MATERIAL NAMES,
 * through every `IfcMaterial*` indirection. Material was in no channel at all,
 * so re-specifying an element moved nothing.
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
  extractAllMaterialsOnDemand,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { lensMaterialNames } from '../lens-material-names.js';
import type { EntityWorldAabb, MeshData } from '@ifc-lite/geometry';
import { comparableProductIds } from './compareScope.js';
import { isGeometricDataName } from './geometricData.js';
import { isTypeObjectClass, typeObjectTag } from './typeObjectTag.js';
import { worldPlacementFingerprint } from './worldPlacement.js';

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
  /**
   * Did the geometry pass produce anything drawable under {@link globalId}?
   *
   * `false` for a product that reached the comparison through
   * `comparableProductIds` alone — there is no mesh and no instanced entry, so
   * `setColorOverrides` on this id is a no-op and hiding it suppresses nothing.
   * The overlay needs that distinction: its rule for a modified element is
   * "colour the head copy, hide the base copy so the two do not z-fight", and
   * that rests on the head copy being drawable. See `overlay.ts`.
   *
   * Distinct from `geometryHash === undefined`, which is also what a meshed
   * entity carries when hashing is off — that entity is still drawn.
   *
   * OPTIONAL and read as "drawable unless explicitly `false`": a hand-built
   * ref (tests, older call sites) keeps the pre-existing behaviour rather than
   * being demoted to invisible by omission.
   */
  meshed?: boolean;
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
   * `meshes` — i.e. federation-global, `local + idOffset`; the loader applies
   * that shift to a federated model's instanced-only ids at finalize just like
   * it does for `meshes`, #1912). Without this, compare would silently miss
   * geometry changes on instanced elements.
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
 * Build one {@link EntityFingerprint} per compared entity in a model — every
 * meshed entity, plus every geometry-less `IfcProduct` (`comparableProductIds`).
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
  // `bigint` is a WASM mesh hash; `string` is a `p:`-prefixed composed-world-
  // placement fingerprint for a geometry-less product (`worldPlacement.ts`).
  // The engine's `GeometryHash` admits both, and the prefix keeps the two
  // value spaces disjoint.
  const geometryByLocalId = new Map<number, bigint | string | undefined>();
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

  // Finally, the products the geometry pass never saw: an IfcElementAssembly
  // whose meshes all hang off its IfcRelAggregates parts, an IfcSite, a
  // placeholder proxy marking a survey origin. They are compared on their data
  // alone, so they enter with an explicitly UNDEFINED geometry hash — the same
  // value a meshed entity gets when hashing is off, and the value
  // `geometryEqual` reads as "no geometry change" when both sides have it.
  // Added last and gap-filling only, so every id the meshes produced keeps both
  // its hash and its position in the built array.
  // Recorded rather than re-derived: `geometryHash === undefined` also
  // describes a MESHED entity on a build with hashing off, and that one is
  // still drawn. Only the ids collected here are absent from the scene.
  const geometryless = new Set<number>();
  for (const localId of comparableProductIds(store)) {
    if (geometryByLocalId.has(localId)) continue;
    // Not `undefined` — their COMPOSED WORLD PLACEMENT, when they have one.
    // These entities have no mesh, so nothing else can speak for where they
    // are, and an entire re-georeferenced IfcSite went unreported for exactly
    // that reason. A meshed entity is deliberately excluded: its placement is
    // already inside the WASM hash it carries, which is strictly better
    // evidence, and displacing that hash would also break the content-matching
    // tier that sub-buckets on it. `worldPlacementFingerprint` abstains
    // (`undefined`, the prior behaviour) for a product with no placement, an
    // uncomposable chain or a malformed one — see `worldPlacement.ts` for why
    // it must be the composed transform and never the local one.
    geometryByLocalId.set(localId, worldPlacementFingerprint(store, localId));
    geometryless.add(localId);
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
      ref: { modelId, localId, globalId: localId + idOffset, meshed: !geometryless.has(localId) },
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
  // `Tag`, and only for a TYPE OBJECT (issue #2021). Type objects reach this
  // adapter because the wasm pass emits type geometry too (#957/#994 —
  // geometryClass 1 orphan, 2 instanced type library), and they are exactly the
  // entities the data hash cannot separate on its own: same name, same class,
  // no occurrence attributes, differing only in `Tag`. On an OCCURRENCE it stays
  // out, because there it is the authoring tool's element id rather than design
  // content and `dataHash` is the content bucket key; see
  // `DataFingerprintInput.tag`.
  const tag = isTypeObjectClass(ifcType)
    ? typeObjectTag(store, localId, ifcType)
    : undefined;

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

  // Resolved material NAMES (never entity references — express ids are
  // reassigned on every save). `extractAllMaterialsOnDemand` is the parser's
  // canonical resolver: it follows `IfcMaterialLayerSetUsage` /
  // `IfcMaterialProfileSetUsage` to their sets, and occurrence associations
  // take precedence over the type's; `lensMaterialNames` then takes the
  // individual layer / constituent / profile / list-member names, falling back
  // to the top-level name only when the element has no sub-structure. Two
  // proxies re-specified from `Soil1` to `topsoil` went unreported before this
  // — materials were in no comparison channel at all.
  const materials = extractAllMaterialsOnDemand(store, localId).flatMap(lensMaterialNames);

  return {
    ifcType,
    name: store.entities.getName(localId) || undefined,
    description: store.entities.getDescription(localId) || undefined,
    objectType: store.entities.getObjectType(localId) || undefined,
    predefinedType: predefinedType != null ? String(predefinedType) : undefined,
    tag: tag != null ? String(tag) : undefined,
    propertySets,
    quantitySets,
    typeAssignments,
    materials,
  };
}

/** Round a geometry-derived quantity to the compare panel's display precision
 *  (4 dp) so re-exporting a model with sub-tolerance float jitter doesn't flip
 *  the data hash on an otherwise-identical element. */
function roundQuantity(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value;
}
