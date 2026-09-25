/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mutation slice - manages property/quantity mutations for IFC export
 */

import { type StateCreator } from 'zustand';
import type { ViewerState } from '../index.js';
import type { MutablePropertyView, NewEntity, IfcAttributeValue } from '@ifc-lite/mutations';
import { StoreEditor } from '@ifc-lite/mutations';
import type { Mutation, ChangeSet, PropertyValue } from '@ifc-lite/mutations';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import {
  addBeamToStore,
  addColumnToStore,
  addDoorToStore,
  addMemberToStore,
  addPlateToStore,
  addRoofToStore,
  addSlabToStore,
  addSpaceToStore,
  addWallToStore,
  addWindowToStore,
  resolveSpatialAnchor,
  duplicateInStore,
  resolveDuplicateSource,
  generateSpacesFromWalls,
  type BeamInStoreParams,
  type ColumnInStoreParams,
  type DoorInStoreParams,
  type DuplicateInStoreOptions,
  type GenerateSpacesOptions,
  type GenerateSpacesResult,
  type MemberInStoreParams,
  type PlateInStoreParams,
  type RoofInStoreParams,
  type SlabInStoreParams,
  type SpaceInStoreParams,
  type WallInStoreParams,
  type WindowInStoreParams,
} from '@ifc-lite/create';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { getEntityBounds, getEntityCenter } from '@/utils/viewportUtils';
import { toGlobalIdFromModels } from '../globalId.js';
import { meshesForOwningModel } from '../owningModelMeshes.js';
import { modelRotationBaker } from '../../lib/model-placement/rotation-bake.js';
import { buildElementMesh } from './addElementMeshes.js';
import { authoredElementMeshPayload, type AuthoredElement } from './authoredElement.js';
import { appendAuthoredMesh, authoredDataStore, syncAuthoredTreeEntry } from './authoredTreeEntry.js';
import { ensureStoreyPlacement } from './storeyPlacement.js';

export type { AuthoredElement };
import { createCostUndoMutations, type CostUndoMethods } from './mutation-cost-undo.js';
import { stashAndPruneEntityMesh, pruneStashByModel, type RemovedMeshStash } from './mutation-mesh-stash.js';
import { applyDuplicatePreAlignmentBaseline } from './mutation-duplicate-prealign.js';
import { pruneMutationHistory } from './mutation-history-prune.js';
import { invalidateHistoryPatch } from './mutation-redo-remote-guard.js';
import type { TypeViewMode } from '../constants.js';
import {
  resolvePlacementChain,
  resolveRotationState,
  resolveWallEditChain,
  computeWallSplitGeometry,
  projectOntoWallAxis,
} from '@/lib/placement-edit.js';
import { cloneElementMetadata } from '@/lib/metadata-clone.js';
import {
  resolveLinearElementChain,
  computeLinearElementSplitGeometry,
  projectOntoLinearAxis,
  type LinearElementType,
} from '@/lib/linear-element-edit.js';
import { reassignWallOpenings } from '@/lib/wall-opening-reassign.js';
import {
  resolveSlabEditChain,
  computeSlabSplitGeometry,
  type SlabLikeType,
} from '@/lib/slab-edit.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import type { Point2D } from '@/lib/polygon-clip.js';
import { registerAuthoredElement } from '@/utils/spatialHierarchy.js';
import { newMutationBatchId, withMutationBatchTags } from './mutation-batch-tags.js';
import { syncTypeOverride } from './mutation-history-apply.js';
import { recordMutationBatch, replayHistory } from './mutation-history-replay.js';

/**
 * IFC-space directions for {@link MutationSlice.duplicateEntity}.
 *
 * Axes match the IFC storey-local frame, which the user already sees
 * in the Raw STEP tab:
 * - +X / -X — east / west
 * - +Y / -Y — north / south
 * - +Z / -Z — up / down
 *
 * The slice converts these to a viewer-space delta when cloning the
 * source's meshes for immediate render.
 */
export type DuplicateDirection = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

/** Default direction used when neither the menu nor `⌘D` provides one. */
export const DUPLICATE_DEFAULT_DIRECTION: DuplicateDirection = '+X';

/** Fallback step in metres when the source has no mesh in geometry. */
const DUPLICATE_FALLBACK_STEP = 1;

/**
 * New occurrence geometry from an authoring action (add element, duplicate,
 * split) is a class-0 mesh, which the 3D "Types" view deliberately hides. If
 * the user is in Types view when they commit such an action, flip back to
 * Model so the element they just created actually renders — otherwise the
 * toast says "added" but nothing appears. No-op when already in Model view
 * (so it never needlessly overwrites the persisted preference). Reads the
 * live store via the cross-slice `get()`.
 */
function revealAddedGeometryInModelView(get: () => unknown): void {
  const cross = get() as {
    typeViewMode?: TypeViewMode;
    setTypeViewMode?: (mode: TypeViewMode) => void;
  };
  if (cross.typeViewMode === 'types') cross.setTypeViewMode?.('model');
}

interface ViewerBox {
  /** Per-axis sizes in viewer scene coordinates. */
  size: { x: number; y: number; z: number };
}

/**
 * Compute the IFC-space offset for a directional duplicate, sized to
 * the source's bounding box so the duplicate sits next to the source
 * (edge-to-edge) rather than overlapping it.
 *
 * Mapping (renderer is Y-up, IFC is Z-up):
 *   viewer X  = IFC X     (matching axis)
 *   viewer Y  = IFC Z     (up)
 *   viewer Z  = -IFC Y    (forward)
 */
function ifcOffsetForDirection(dir: DuplicateDirection, bbox: ViewerBox): [number, number, number] {
  const sx = bbox.size.x || DUPLICATE_FALLBACK_STEP;
  const sy = bbox.size.z || DUPLICATE_FALLBACK_STEP; // viewer Z → IFC Y
  const sz = bbox.size.y || DUPLICATE_FALLBACK_STEP; // viewer Y → IFC Z
  switch (dir) {
    case '+X': return [sx, 0, 0];
    case '-X': return [-sx, 0, 0];
    case '+Y': return [0, sy, 0];
    case '-Y': return [0, -sy, 0];
    case '+Z': return [0, 0, sz];
    case '-Z': return [0, 0, -sz];
  }
}

/** Convert an IFC-space delta to the viewer's Y-up scene frame. */
function viewerDeltaFromIfc(ifc: [number, number, number]): { x: number; y: number; z: number } {
  return { x: ifc[0], y: ifc[2], z: -ifc[1] };
}

/**
 * Clone every mesh tagged with `sourceGlobalId` and translate its
 * vertex positions by `viewerOffset`. Normals are reused (translation
 * doesn't affect orientation). Returns an empty array when the source
 * isn't currently in the geometry result — caller falls back to
 * relying on the export-only overlay.
 */
function cloneMeshesWithOffset(
  meshes: MeshData[] | undefined,
  sourceGlobalId: number,
  newGlobalId: number,
  viewerOffset: { x: number; y: number; z: number },
): MeshData[] {
  if (!meshes || meshes.length === 0) return [];
  const out: MeshData[] = [];
  for (const m of meshes) {
    if (m.expressId !== sourceGlobalId) continue;
    // Positions are in the element's local frame (world = origin + position).
    // Keep the buffer verbatim-local (f32-precise) and fold the duplicate's
    // viewerOffset into the per-element origin instead, so the copy lands at
    // original-world + offset without re-quantizing vertices at world scale.
    const positions = new Float32Array(m.positions);
    const origin: [number, number, number] = [
      (m.origin?.[0] ?? 0) + viewerOffset.x,
      (m.origin?.[1] ?? 0) + viewerOffset.y,
      (m.origin?.[2] ?? 0) + viewerOffset.z,
    ];
    out.push({
      expressId: newGlobalId,
      positions,
      normals: m.normals,
      indices: m.indices,
      color: m.color,
      ifcType: m.ifcType,
      modelIndex: m.modelIndex,
      origin,
      // Per-vertex entity ids only matter for color-merged batches;
      // a single-mesh duplicate carries one expressId everywhere.
      entityIds: m.entityIds ? new Uint32Array(m.entityIds.length).fill(newGlobalId) : undefined,
    });
  }
  return out;
}

/** Tracks georeferencing field mutations per model */
export interface GeorefMutationData {
  projectedCRS?: Partial<ProjectedCRS>;
  mapConversion?: Partial<MapConversion>;
}

export interface MutationSlice extends CostUndoMethods {
  // State
  /** Mutation views per model */
  mutationViews: Map<string, MutablePropertyView>;
  /** Per-model StoreEditor caches (created on demand). Keyed by mutation-view modelId. */
  storeEditors: Map<string, StoreEditor>;
  /**
   * Tombstoned overlay entities, keyed by `${modelId}:${expressId}`. Stashed
   * so undo of a `removeEntity` on a freshly-added overlay entity can replay
   * the same NewEntity record back into the view.
   */
  removedNewEntities: Map<string, NewEntity>;
  /**
   * Meshes pruned from `geometryResult` by DELETE_ENTITY / undoing a
   * CREATE_ENTITY, keyed by `${modelId}:${expressId}`. The inverse
   * mutation re-appends them — see `mutation-mesh-stash.ts` (#4925).
   */
  removedMeshes: Map<string, RemovedMeshStash>;
  /** All change sets */
  changeSets: Map<string, ChangeSet>;
  /** Active change set ID */
  activeChangeSetId: string | null;
  /** Undo stack per model */
  undoStacks: Map<string, Mutation[]>;
  /** Redo stack per model */
  redoStacks: Map<string, Mutation[]>;
  /**
   * Maps mutationId → batchId. Mutations created via
   * `setPositionalAttributesBatch` share a single batchId so the
   * undo / redo handlers can pop / push them as one atomic
   * step — important for compound operations like `resizeWall`
   * (4 positional writes) where the user expects one Ctrl+Z to
   * undo the whole resize, not unwind through inconsistent
   * intermediate states.
   *
   * Stored as a side-channel on the slice (vs an extra field on
   * the published `Mutation` interface) so the batching is a
   * viewer-local concern and doesn't ripple through @ifc-lite/
   * mutations consumers.
   */
  mutationBatchTags: Map<string, string>;
  /**
   * Maps mutationId → the renderer-frame mesh translation that
   * accompanied a placement-move mutation (`translateEntity` /
   * `setEntityPosition`). The mutation itself only records the
   * IfcCartesianPoint coordinate change; the rendered mesh moves
   * via a separate `setPendingMeshTranslations` call. Undo / redo
   * of the IFC value alone would leave the 3D mesh stranded at the
   * moved position, so the handlers replay (redo) or negate (undo)
   * the translation recorded here.
   *
   * Side-channel for the same reason as `mutationBatchTags`: keeps
   * the renderer coupling out of the published Mutation interface.
   */
  mutationMeshTranslations: Map<string, { globalId: number; rendererDelta: [number, number, number] }>;
  /** Models with unsaved changes */
  dirtyModels: Set<string>;
  /** Version counter to trigger re-renders when mutations change */
  mutationVersion: number;
  /** Georeferencing mutations per model */
  georefMutations: Map<string, GeorefMutationData>;

  // Actions - Georeferencing Mutations
  /** Set a georeferencing field value */
  setGeorefField: (
    modelId: string,
    entity: 'projectedCRS' | 'mapConversion',
    field: string,
    value: string | number,
    oldValue?: string | number
  ) => void;
  /** Set multiple georeferencing field values atomically */
  setGeorefFields: (
    modelId: string,
    entity: 'projectedCRS' | 'mapConversion',
    fields: Array<{ field: string; value: string | number; oldValue?: string | number }>
  ) => void;
  /** Get merged georef mutations for a model */
  getGeorefMutations: (modelId: string) => GeorefMutationData | undefined;

  // Actions - Mutation View Management
  /** Get or create mutation view for a model */
  getMutationView: (modelId: string) => MutablePropertyView | null;
  /** Register a mutation view for a model */
  registerMutationView: (modelId: string, view: MutablePropertyView) => void;
  /** Clear mutation view for a model */
  clearMutationView: (modelId: string) => void;

  // Actions - Property Mutations
  /** Set a property value */
  setProperty: (
    modelId: string,
    entityId: number,
    psetName: string,
    propName: string,
    value: PropertyValue,
    valueType?: PropertyValueType, dataType?: string
  ) => Mutation | null;
  /** Delete a property */
  deleteProperty: (
    modelId: string,
    entityId: number,
    psetName: string,
    propName: string
  ) => Mutation | null;
  /** Create a new property set */
  createPropertySet: (
    modelId: string,
    entityId: number,
    psetName: string,
    properties: Array<{ name: string; value: PropertyValue; type?: PropertyValueType }>
  ) => Mutation | null;
  /** Delete a property set */
  deletePropertySet: (
    modelId: string,
    entityId: number,
    psetName: string
  ) => Mutation | null;

  // Actions - Quantity Mutations
  /** Set a quantity value */
  setQuantity: (
    modelId: string,
    entityId: number,
    qsetName: string,
    quantName: string,
    value: number,
    quantityType?: QuantityType,
    unit?: string
  ) => Mutation | null;
  /** Create a new quantity set */
  createQuantitySet: (
    modelId: string,
    entityId: number,
    qsetName: string,
    quantities: Array<{ name: string; value: number; quantityType: QuantityType; unit?: string }>
  ) => Mutation | null;

  // Actions - Attribute Mutations
  /** Set an entity attribute value */
  setAttribute: (
    modelId: string,
    entityId: number,
    attrName: string,
    value: string,
    oldValue?: string
  ) => Mutation | null;

  /**
   * Reassign an entity's IFC class in place ("retype"). The expressId is
   * unchanged, so geometry / placement / representation and every IfcRel*
   * reference carry over; the exporter re-lays-out attributes against the
   * target class. Materializes on STEP export. Returns the recorded mutation.
   */
  setEntityType: (
    modelId: string,
    entityId: number,
    newType: string,
    predefinedType?: string | null
  ) => Mutation | null;

  // Actions - Store-Level Mutations (raw STEP entity edits)
  /**
   * Edit a positional STEP argument by zero-based index. Used by the Raw
   * STEP editor for non-IfcRoot entities (profile dimensions, cartesian
   * point coords, etc.) where the attribute has no symbolic name.
   */
  setPositionalAttribute: (
    modelId: string,
    entityId: number,
    index: number,
    value: IfcAttributeValue
  ) => Mutation | null;
  /**
   * Atomic batch of positional writes — undo / redo treat the
   * whole list as one operation. Each entry produces a primitive
   * `UPDATE_POSITIONAL_ATTRIBUTE` mutation under the hood (same
   * shape as `setPositionalAttribute` so the undo handler stays
   * uniform), but all entries share a batchId via
   * `mutationBatchTags` so a single Ctrl+Z reverts the entire
   * batch.
   *
   * Used by compound operations like `resizeWall` (4 coordinated
   * positional writes) so the user doesn't have to press Ctrl+Z
   * four times to undo one resize. Returns the batchId so callers
   * can correlate; empty input is a no-op (returns null).
   */
  setPositionalAttributesBatch: (
    modelId: string,
    updates: Array<{ entityId: number; index: number; value: IfcAttributeValue }>,
  ) => string | null;
  /** Tag already-recorded mutations as one undo batch (SDK `bim.mutate.batch`). */
  tagMutationBatch: (mutationIds: readonly string[], batchId: string) => void;
  /**
   * Record mutations a bulk writer already applied to the model's view
   * (Bulk editor, CSV import) as ONE undo step: one batch id, redo cleared,
   * model marked dirty, one store update. Returns the batch id (null if empty); pass it back for a later chunk.
   */
  recordMutationBatch: (modelId: string, mutations: readonly Mutation[], batchId?: string) => string | null;
  /**
   * Tombstone an entity (existing source entity) or forget it (overlay-only).
   * Returns true if the entity was known to the store or overlay.
   */
  removeEntity: (modelId: string, expressId: number, opts?: { mirror?: boolean }) => boolean;
  /**
   * Book an element another writer (the SDK `bim.store.add*` adapter) has
   * already built into the overlay: spatial tree, 3D mesh, undo entry, dirty
   * flag and `mutationVersion` — everything `addColumn` & co. do after their
   * builder runs, minus collab mirroring, which that writer owns.
   */
  recordAuthoredElement: (modelId: string, storeyExpressId: number, entityId: number, element: AuthoredElement) => void;
  /**
   * Book a removal another writer (the SDK `bim.store.removeEntity` adapter)
   * already applied: prune the mesh, stash the overlay record for undo, push
   * the undo entry. Collab mirroring stays with that writer.
   */
  recordEntityRemoval: (modelId: string, expressId: number, overlayRecord: NewEntity | null | undefined) => void;
  /**
   * Translate an IfcProduct by a storey-local delta (IFC Z-up). Walks
   * the placement chain to the terminal `IfcCartesianPoint` and writes
   * the new coordinates via `setPositionalAttribute` so the edit
   * stacks with other overlay mutations and undoes cleanly.
   *
   * Returns `{ ok: false }` for entities whose placement isn't a
   * simple `IfcLocalPlacement → IfcAxis2Placement3D → IfcCartesianPoint`
   * chain (mapped representations, 2D placements, non-product
   * entities). The viewer surfaces the reason as a toast.
   *
   * `batchId` (optional) tags the mutation so a drag that emits
   * many per-frame `translateEntity` calls collapses to one undo
   * step. The gizmo passes one id per drag; omit it for a
   * standalone move (e.g. a single numeric-input commit).
   */
  translateEntity: (
    modelId: string,
    expressId: number,
    deltaIfc: [number, number, number],
    batchId?: string,
  ) => { ok: true; newCoordinates: [number, number, number] } | { ok: false; reason: string };
  /**
   * Absolute version of `translateEntity` — replaces the entity's
   * storey-local position instead of adding a delta. Same chain
   * requirements apply.
   */
  setEntityPosition: (
    modelId: string,
    expressId: number,
    position: [number, number, number],
  ) => { ok: true; newCoordinates: [number, number, number] } | { ok: false; reason: string };
  /**
   * Rotate an IfcProduct about the storey-up Z axis by `deltaYaw`
   * radians. Updates RefDirection on the placement's
   * IfcAxis2Placement3D when one already exists.
   *
   * Refuses with `{ ok: false }` when the entity's placement has
   * no explicit RefDirection (the implicit `[1, 0, 0]` STEP
   * default). Materialising a fresh IfcDirection there would
   * require a multi-mutation atomic undo entry to avoid orphans
   * on undo, which the store doesn't have yet. Every entity
   * emitted by `@ifc-lite/create`'s in-store builders carries an
   * explicit RefDirection, so the refusal only trips on
   * hand-rolled source-buffer entities.
   */
  rotateEntity: (
    modelId: string,
    expressId: number,
    deltaYaw: number,
  ) => { ok: true; newYawZ: number } | { ok: false; reason: string };
  /**
   * Snapshot of the placement's current yaw about Z (radians) plus
   * the metadata the UI needs to render a rotation gizmo. Returns
   * null when the placement chain isn't translatable.
   */
  readEntityRotation: (
    modelId: string,
    expressId: number,
  ) => { yawZ: number; refDirection: [number, number, number] } | null;
  /**
   * Read the entity's storey-local placement coordinates. Returns
   * null when the placement chain isn't a simple
   * `IfcLocalPlacement → IfcAxis2Placement3D → IfcCartesianPoint`
   * (i.e. when `translateEntity` / `setEntityPosition` wouldn't work
   * either). The action lazily creates the `StoreEditor` on first
   * call so it works on a freshly-loaded model that hasn't seen any
   * mutations yet — `MutablePropertyView` is the only thing
   * `PropertiesPanel` registers up front, and the editor is a thin
   * facade we can build on demand. Pairing the gate condition with
   * the existing read-actions keeps "is this entity movable?" and
   * "what are its coords?" answered by the same code path.
   */
  readEntityPosition: (
    modelId: string,
    expressId: number,
  ) => [number, number, number] | null;
  /**
   * Resize a rectangular-profile wall by setting new start AND end
   * points. Atomically updates the placement origin, RefDirection,
   * profile length, and profile origin. Returns null for walls that
   * don't follow the `addWallToStore` shape.
   */
  resizeWall: (
    modelId: string,
    expressId: number,
    newStart: [number, number, number],
    newEnd: [number, number, number],
  ) => { ok: true; newLength: number } | { ok: false; reason: string };
  /**
   * Read a wall's current start/end so the UI can render endpoint
   * handles. Returns null for non-rectangle walls.
   */
  readWallEndpoints: (
    modelId: string,
    expressId: number,
  ) => { start: [number, number, number]; end: [number, number, number]; thickness: number } | null;
  /**
   * Split a rectangle-profile wall into two walls at `distance`
   * metres along its axis (measured from the wall's start). Produces
   * two new walls inheriting the source's Pset / Qto / classification
   * / material / type relationships, then tombstones the source.
   *
   * Returns the two new walls' express ids and federation global
   * ids on success. On failure (non-rectangle wall, distance too
   * close to an end, missing storey, etc.) returns a descriptive
   * reason for the UI to surface.
   *
   * Undo posture: the action lands as three primitive mutations on
   * the model's undo stack (one per new wall create, one for the
   * source delete), so a full revert needs three Ctrl+Z presses
   * today. A batched-mutation primitive that collapses this to one
   * step is on the follow-up list from PR #723.
   */
  splitWallAtDistance: (
    modelId: string,
    expressId: number,
    distanceFromStart: number,
  ) => { ok: true; left: { expressId: number; globalId: number }; right: { expressId: number; globalId: number }; openings: { toLeft: number; toRight: number; skipped: number } } | { ok: false; reason: string };
  /**
   * Read-only helper for the Split-tool live preview: projects an
   * arbitrary storey-local 3D cursor onto the wall axis and returns
   * how far along the wall (in metres from start) it lands, plus
   * the wall's total length so the UI can show "1.42 m / 3.50 m".
   *
   * Returns null when the entity isn't a resizable wall.
   */
  readWallSplitProjection: (
    modelId: string,
    expressId: number,
    cursorStoreyLocal: [number, number, number],
  ) => { distance: number; length: number; cutPoint: [number, number, number]; axis: [number, number, number] } | null;
  /**
   * Split a linear element (`IfcBeam` / `IfcColumn` / `IfcMember`)
   * at `distance` metres from start. Unlike walls, the source's
   * extrusion is shrunk in place so the "left" half keeps the
   * source's GlobalId and Pset rels — the choice is forced by the
   * IFC representation (length lives on the extrusion `Depth`, not
   * on the profile XDim), so one positional write covers it. A new
   * element is added at the cut point to carry the "right" half.
   */
  splitLinearElementAtDistance: (
    modelId: string,
    expressId: number,
    distanceFromStart: number,
  ) => { ok: true; source: { expressId: number; globalId: number }; right: { expressId: number; globalId: number } } | { ok: false; reason: string };
  /**
   * Linear-element analogue of `readWallSplitProjection`. Returns
   * null when the entity isn't an `addBeam` / `addColumn` /
   * `addMember` -shaped element.
   */
  readLinearElementSplitProjection: (
    modelId: string,
    expressId: number,
    cursorStoreyLocal: [number, number, number],
  ) => { distance: number; length: number; cutPoint: [number, number, number]; axis: [number, number, number]; elementType: LinearElementType } | null;
  /**
   * Read a slab-like element's storey-local footprint polygon so
   * the Split overlay can render the live cut-line preview. The
   * footprint comes back in storey-local 2D (XY) with the
   * placement origin already added. Returns null for non-slab
   * selections or representations the chain resolver doesn't
   * support (mapped shapes, tessellated faces, etc).
   */
  readSlabFootprint: (
    modelId: string,
    expressId: number,
  ) => { footprint: Point2D[]; elementType: SlabLikeType; storeyElevation: number; thickness: number } | null;
  /**
   * Split a slab-like element (IfcSlab / IfcRoof / IfcPlate /
   * IfcSpace) along a cut line defined by two storey-local 2D
   * points. Builds two fresh elements with the clipped footprints
   * (polygon-mode `IfcArbitraryClosedProfileDef` even when the
   * source was a rectangle — most cuts produce non-rectangular
   * halves), clones metadata onto both, then tombstones the
   * source.
   *
   * Selection moves to whichever half contains the second click,
   * so the user can keep editing the new piece immediately.
   */
  splitSlabByLine: (
    modelId: string,
    expressId: number,
    cutA: [number, number],
    cutB: [number, number],
  ) => { ok: true; left: { expressId: number; globalId: number }; right: { expressId: number; globalId: number } } | { ok: false; reason: string };
  /**
   * Add a fully-anchored IfcColumn (and its sub-graph) to a parsed model.
   * Returns the new column's expressId, or null if the model can't be
   * resolved or the storey anchor lookup fails.
   */
  addColumn: (
    modelId: string,
    storeyExpressId: number,
    params: ColumnInStoreParams
  ) => { expressId: number } | { error: string };
  /** Add an IfcWall anchored to a storey. */
  addWall: (
    modelId: string,
    storeyExpressId: number,
    params: WallInStoreParams
  ) => { expressId: number } | { error: string };
  /** Add an IfcSlab anchored to a storey. */
  addSlab: (
    modelId: string,
    storeyExpressId: number,
    params: SlabInStoreParams
  ) => { expressId: number } | { error: string };
  /** Add an IfcBeam anchored to a storey. */
  addBeam: (
    modelId: string,
    storeyExpressId: number,
    params: BeamInStoreParams
  ) => { expressId: number } | { error: string };
  /** Add a free-standing IfcDoor anchored to a storey. */
  addDoor: (
    modelId: string,
    storeyExpressId: number,
    params: DoorInStoreParams
  ) => { expressId: number } | { error: string };
  /** Add a free-standing IfcWindow anchored to a storey. */
  addWindow: (
    modelId: string,
    storeyExpressId: number,
    params: WindowInStoreParams
  ) => { expressId: number } | { error: string };
  /** Add an IfcSpace (room) — rectangle or polygon footprint. */
  addSpace: (
    modelId: string,
    storeyExpressId: number,
    params: SpaceInStoreParams,
    /** Plan outline for the 3D mirror — see `profileCornersFromParams`. */
    previewCorners?: Array<[number, number]>
  ) => { expressId: number } | { error: string };
  /** Add an IfcRoof (flat roof) — slab-like rectangle or polygon. */
  addRoof: (
    modelId: string,
    storeyExpressId: number,
    params: RoofInStoreParams
  ) => { expressId: number } | { error: string };
  /** Add an IfcPlate (thin flat element) — slab-like rectangle or polygon. */
  addPlate: (
    modelId: string,
    storeyExpressId: number,
    params: PlateInStoreParams
  ) => { expressId: number } | { error: string };
  /** Add an IfcMember (generic structural — brace, post, strut). */
  addMember: (
    modelId: string,
    storeyExpressId: number,
    params: MemberInStoreParams
  ) => { expressId: number } | { error: string };
  /** Auto-generate IfcSpace volumes for every enclosed area formed by the storey's walls
   *  (existing + overlay). `dryRun: true` detects without emitting — for live UI previews. */
  generateSpacesFromWalls: (
    modelId: string,
    storeyExpressId: number,
    options?: GenerateSpacesOptions,
  ) => GenerateSpacesResult | { error: string };
  /**
   * Duplicate an existing IfcRoot product in a chosen direction.
   * Offset magnitude is one source-bbox dimension along the picked
   * IFC axis (so a 3m wall steps 3m, a 0.4m column steps 0.4m).
   * Geometry is shared with the source via Representation reference
   * AND mirrored into the renderer's mesh list with the offset
   * applied — so the duplicate appears in 3D the moment the action
   * fires, not just in the export overlay. Returns the new entity's
   * express id, or an error message.
   */
  duplicateEntity: (
    modelId: string,
    sourceExpressId: number,
    direction?: DuplicateDirection,
    options?: DuplicateInStoreOptions
  ) => { expressId: number; globalId: number } | { error: string };

  // Actions - Undo/Redo
  /** Undo last mutation for a model */
  undo: (modelId: string) => void;
  /** Redo last undone mutation for a model */
  redo: (modelId: string) => void;
  /** Check if undo is available */
  canUndo: (modelId: string) => boolean;
  /** Check if redo is available */
  canRedo: (modelId: string) => boolean;
  /** Clears history for a peer-edited entity (#5223). */ invalidateHistoryForEntity: (modelId: string, entityId: number) => void;

  // Actions - Change Sets
  /** Create a new change set */
  createChangeSet: (name: string) => string;
  /** Get active change set */
  getActiveChangeSet: () => ChangeSet | null;
  /** Set active change set */
  setActiveChangeSet: (id: string | null) => void;
  /** Export change set as JSON */
  exportChangeSet: (id: string) => string | null;
  /** Import change set from JSON */
  importChangeSet: (json: string) => void;

  // Actions - Query
  /** Check if a model has unsaved changes */
  hasChanges: (modelId: string) => boolean;
  /** Get all mutations for a model */
  getMutationsForModel: (modelId: string) => Mutation[];
  /** Get count of modified entities across all models */
  getModifiedEntityCount: () => number;

  // Actions - Reset
  /** Clear all mutations for a model */
  clearMutations: (modelId: string) => void;
  /** Clear all mutations */
  clearAllMutations: () => void;
  /** Manually bump mutation version (for bulk operations that bypass store) */
  bumpMutationVersion: () => void;
  /**
   * Mark models as having unsaved changes, and bump the mutation version, in
   * ONE update.
   *
   * For bulk writers that go straight to a model's `MutablePropertyView`
   * (zone write-back, #2508). Those cannot drive the per-mutation actions
   * above: each of them copies the model's whole undo stack, so calling one
   * per element is quadratic. `bumpMutationVersion` alone is not enough  - 
   * without the dirty flag the model reports no unsaved changes while its
   * overlay holds thousands of them.
   */
  markModelsDirty: (modelIds: readonly string[]) => void;
}

function generateChangeSetId(): string {
  return `cs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function getOrCreateStoreEditor(
  get: () => ViewerState,
  // Editors are cached in-place on the (non-reactive) `storeEditors`
  // Map below, so the Zustand setter is intentionally unused here.
  _set: (partial: Partial<ViewerState>) => void,
  modelId: string,
): StoreEditor | null {
  const state = get();
  const cached = state.storeEditors.get(modelId);
  if (cached) return cached;

  const view = state.mutationViews.get(modelId);
  if (!view) return null;

  const model = state.models.get(modelId);
  const dataStore = model?.ifcDataStore;
  if (!dataStore) return null;

  const editor = new StoreEditor(dataStore, view);
  // `storeEditors` is an internal, non-reactive cache (no component
  // subscribes to it). Mutate the existing Map in place rather than
  // `set({...})` — the read functions (readSlabFootprint, etc.) call
  // this during render via GeometryEditCard's `splittable` memo, and a
  // reactive `set()` there triggers React's "cannot update a component
  // while rendering a different component" warning. In-place caching
  // keeps the editor memoised without scheduling a render-phase update.
  state.storeEditors.set(modelId, editor);
  return editor;
}

/**
 * Resolve the (view, editor, dataStore, storey) tuple that every
 * splitWall / splitLinearElement / splitSlab action needs. Returns
 * an error result with a stable message when any piece is missing
 * so each action's preamble collapses to a single early-return.
 *
 * Pass `requireStorey: false` when the caller resolves storey from
 * a different source (none currently — but the flag keeps the
 * helper reusable for non-storey-bound split-like flows).
 */
type SplitContext = {
  view: MutablePropertyView;
  editor: StoreEditor;
  dataStore: import('@ifc-lite/parser').IfcDataStore;
  storeyExpressId: number;
};
function resolveSplitContext(
  get: () => ViewerState,
  set: (partial: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => void,
  modelId: string,
  expressId: number,
  notInStoreyMessage: string,
): SplitContext | { ok: false; reason: string } {
  const state = get();
  const view = state.mutationViews.get(modelId);
  if (!view) return { ok: false, reason: 'Model has no editable mutation view yet' };
  const editor = getOrCreateStoreEditor(get, set, modelId);
  if (!editor) return { ok: false, reason: 'Failed to resolve store editor' };
  const dataStore = state.models.get(modelId)?.ifcDataStore;
  if (!dataStore) return { ok: false, reason: `No model loaded for id "${modelId}"` };
  const storeyExpressId = dataStore.spatialHierarchy?.elementToStorey.get(expressId);
  if (storeyExpressId === undefined) return { ok: false, reason: notInStoreyMessage };
  return { view, editor, dataStore, storeyExpressId };
}

/**
 * Rollback helper for failed atomic operations (e.g. split where
 * the left half was created but the right half's builder threw).
 *
 * Pops the most recent CREATE_ENTITY mutation for `expressId` off
 * the model's undo stack, removes the overlay record via
 * `view.deleteEntity`, and queues the renderer mesh for removal.
 * No DELETE_ENTITY mutation is recorded — the operation never
 * happened from the user's perspective, so the undo history is
 * left clean (Ctrl+Z after a failed split shouldn't bring back
 * the orphan half).
 *
 * Returns true when at least one undo entry was popped.
 */
function rollbackOverlayCreate(
  get: () => ViewerState,
  set: (partial: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => void,
  modelId: string,
  expressId: number,
): boolean {
  const state = get();
  const view = state.mutationViews.get(modelId);
  const editor = state.storeEditors.get(modelId);
  if (!view || !editor) return false;

  // Drop the entity from the overlay. The view.deleteEntity call
  // is silent for already-gone entities — safe even if the caller
  // gets the rollback path wrong.
  editor.removeEntity(expressId);

  // Pop the matching CREATE_ENTITY entry off the undo stack. The
  // split flow always rolls back immediately after the failed
  // create, so the entry is at top-of-stack — fast-path that case
  // with a single `pop()`-style slice and only fall back to the
  // linear scan if a follow-up mutation slipped in between.
  set((s) => {
    const stacks = new Map(s.undoStacks);
    const stack = stacks.get(modelId);
    if (!stack || stack.length === 0) return {};
    const top = stack[stack.length - 1];
    if (top.type === 'CREATE_ENTITY' && top.entityId === expressId) {
      stacks.set(modelId, stack.slice(0, -1));
      return {
        undoStacks: stacks,
        mutationVersion: s.mutationVersion + 1,
      };
    }
    for (let i = stack.length - 2; i >= 0; i--) {
      const m = stack[i];
      if (m.type === 'CREATE_ENTITY' && m.entityId === expressId) {
        const next = stack.slice();
        next.splice(i, 1);
        stacks.set(modelId, next);
        return {
          undoStacks: stacks,
          mutationVersion: s.mutationVersion + 1,
        };
      }
    }
    return {};
  });

  // Drop the entity's mesh from the renderer so the user doesn't
  // see a phantom half-element after the failed split. Uses the
  // existing pendingMeshRemovals channel (same as Phase A).
  const globalId = toGlobalIdFromModels(state.models, modelId, expressId);
  state.setPendingMeshRemovals(new Set([globalId]));
  return true;
}

/**
 * Shared dispatcher for the wall/slab/beam in-store builders. Mirrors the
 * structure of `addColumn` (resolve store/view/editor/anchor → run the
 * builder → push a CREATE_ENTITY undo entry → mark dirty + bump version)
 * without copy-pasting that block per element type.
 */
function runInStoreElementBuilder(
  get: () => ViewerState,
  set: (partial: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => void,
  modelId: string,
  storeyExpressId: number,
  element: AuthoredElement,
  build: (editor: StoreEditor, anchor: ReturnType<typeof resolveSpatialAnchor>) => number,
): { expressId: number } | { error: string } {
  if (!get().canCollabEdit()) return { error: 'Editing is disabled for your role in this shared session' };
  const state = get();
  const model = state.models.get(modelId);
  const dataStore = model?.ifcDataStore;
  if (!dataStore) return { error: `No model loaded for id "${modelId}"` };

  const view = state.mutationViews.get(modelId);
  if (!view) return { error: 'Model has no editable mutation view yet' };

  const editor = getOrCreateStoreEditor(get, set, modelId);
  if (!editor) return { error: 'Failed to create store editor' };

  // Some source IFC files leave IfcBuildingStorey.ObjectPlacement
  // null (it's optional in the schema). Without a placement,
  // resolveSpatialAnchor throws "storey #N has no resolvable
  // IfcLocalPlacement" — but a fresh IfcLocalPlacement at the
  // origin is a valid default. Materialise one before the anchor
  // walk so the user's authoring action doesn't get blocked by
  // missing-but-recoverable IFC structure.
  ensureStoreyPlacement(dataStore, editor, storeyExpressId);

  let entityId: number;
  try {
    const anchor = resolveSpatialAnchor(dataStore, storeyExpressId, view);
    entityId = build(editor, anchor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : `Failed to add ${element.kind}` };
  }

  const createdMesh = recordAuthoredElementIn(get, set, modelId, dataStore, view, storeyExpressId, entityId, element);

  // Mirror the new element to peers (entity + mesh blob). No-op outside collab.
  const newGuid = readNewEntityGuid(editor, entityId);
  get().mirrorEntityCreate(modelId, entityId, authoredIfcType(element), newGuid, createdMesh);

  return { expressId: entityId };
}

const authoredIfcType = (element: AuthoredElement): string => `IFC${element.kind.toUpperCase()}`;

/**
 * Everything after an in-store builder ran, shared by the UI actions and by
 * the SDK `bim.store.add*` adapter. The adapter used to stop at the builder,
 * so a script's or flow's elements existed only in the export overlay: no
 * mesh, no tree entry, no undo, and no `mutationVersion` bump to tell anything
 * they were there. Returns the mesh it injected, for mirroring.
 */
function recordAuthoredElementIn(
  get: () => ViewerState,
  set: (partial: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => void,
  modelId: string,
  dataStore: import('@ifc-lite/parser').IfcDataStore,
  view: MutablePropertyView,
  storeyExpressId: number,
  entityId: number,
  element: AuthoredElement,
): MeshData | null {
  const ifcType = authoredIfcType(element);

  // Make the authored element a first-class citizen immediately: register it in
  // the spatial hierarchy so it appears in the spatial tree under its storey and
  // resolves its storey assignment. The hierarchy is built from the columnar
  // parse at load and otherwise never sees overlay-authored entities — so a
  // baked IfcSpace would be invisible in the tree, have no storey, and (since it
  // can't be picked from the tree) feel un-selectable / un-movable. (Aggregated
  // spaces become a child node; contained elements join the storey's list.)
  if (dataStore.spatialHierarchy) {
    // Name lives on the overlay record (attrs[2] = Name for every IfcRoot
    // subtype), not the columnar parse, so the tree label reads the authored
    // name ("Space 1") rather than falling back to the type.
    const rawName = view.getNewEntity(entityId)?.attributes?.[2];
    const name = typeof rawName === 'string' ? rawName : '';
    registerAuthoredElement(dataStore.spatialHierarchy, storeyExpressId, entityId, ifcType, name);
  }

  // Build a renderer-frame mesh for the new element so it appears in
  // 3D the moment the action commits — the ImportError-only behaviour
  // before this would only surface the change after an export+reparse.
  const storeyElevation =
    dataStore.spatialHierarchy?.storeyElevations?.get(storeyExpressId) ?? 0;
  const globalId = toGlobalIdFromModels(get().models, modelId, entityId);
  const createdMesh = buildElementMesh({
    type: element.kind,
    globalId,
    storeyElevation,
    payload: authoredElementMeshPayload(element),
  });
  if (createdMesh) {
    appendAuthoredMesh(get(), modelId, createdMesh);
    revealAddedGeometryInModelView(get);
  }

  set((s) => {
    const newUndoStacks = new Map(s.undoStacks);
    const stack = newUndoStacks.get(modelId) || [];
    const mutation: Mutation = {
      id: `mut_${ifcType.toLowerCase()}_${entityId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: 'CREATE_ENTITY',
      timestamp: Date.now(),
      modelId,
      entityId,
      attributeName: ifcType,
    };
    newUndoStacks.set(modelId, [...stack, mutation]);

    const newRedoStacks = new Map(s.redoStacks);
    newRedoStacks.set(modelId, []);

    const newDirty = new Set(s.dirtyModels);
    newDirty.add(modelId);

    return {
      undoStacks: newUndoStacks,
      redoStacks: newRedoStacks,
      dirtyModels: newDirty,
      mutationVersion: s.mutationVersion + 1,
    };
  });

  return createdMesh;
}

/**
 * Everything after an entity left the overlay: shared by `removeEntity` and
 * the SDK `bim.store.removeEntity` adapter, which removes through its own
 * editor and would otherwise leave the mesh on screen and nothing to undo.
 */
function recordEntityRemovalIn(
  get: () => ViewerState,
  set: (partial: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => void,
  modelId: string,
  expressId: number,
  overlayRecord: NewEntity | null | undefined,
): void {
  syncAuthoredTreeEntry(get(), modelId, expressId, overlayRecord, false);
  // Drop the entity's mesh out of `geometryResult` (stashed first so
  // undo can restore it) rather than only hiding it — #4925: a
  // hide-only mesh desyncs from a split's separate hard removal.
  // `hideEntities` is a fallback for entities with no mesh to prune.
  const globalIdForMesh = toGlobalIdFromModels(get().models, modelId, expressId);
  if (!stashAndPruneEntityMesh(get, set, modelId, expressId)) {
    get().hideEntities([globalIdForMesh]);
  }

  set((state) => {
    const newRemoved = new Map(state.removedNewEntities);
    if (overlayRecord) {
      newRemoved.set(`${modelId}:${expressId}`, overlayRecord);
    }

    const newUndoStacks = new Map(state.undoStacks);
    const stack = newUndoStacks.get(modelId) || [];
    const mutation: Mutation = {
      id: `mut_del_${expressId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: 'DELETE_ENTITY',
      timestamp: Date.now(),
      modelId,
      entityId: expressId,
    };
    newUndoStacks.set(modelId, [...stack, mutation]);

    const newRedoStacks = new Map(state.redoStacks);
    newRedoStacks.set(modelId, []);

    const newDirty = new Set(state.dirtyModels);
    newDirty.add(modelId);

    return {
      removedNewEntities: newRemoved,
      undoStacks: newUndoStacks,
      redoStacks: newRedoStacks,
      dirtyModels: newDirty,
      mutationVersion: state.mutationVersion + 1,
    };
  });
}

/** Read a freshly-created overlay entity's IFC GlobalId (attribute 0 on IfcRoot). */
function readNewEntityGuid(editor: StoreEditor, expressId: number): string | null {
  const raw = editor.getNewEntity(expressId)?.attributes?.[0];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}


export const createMutationSlice: StateCreator<
  ViewerState,
  [],
  [],
  MutationSlice
> = (set, get, api) => ({
  // Initial state
  mutationViews: new Map(),
  storeEditors: new Map(),
  removedNewEntities: new Map(),
  removedMeshes: new Map(),
  changeSets: new Map(),
  activeChangeSetId: null,
  undoStacks: new Map(),
  redoStacks: new Map(),
  mutationBatchTags: new Map(),
  mutationMeshTranslations: new Map(),
  dirtyModels: new Set(),
  mutationVersion: 0,
  georefMutations: new Map(),

  ...createCostUndoMutations(set),
  // Georeferencing Mutations
  setGeorefField: (modelId, entity, field, value, oldValue) => {
    get().setGeorefFields(modelId, entity, [{ field, value, oldValue }]);
  },

  setGeorefFields: (modelId, entity, fields) => {
    if (fields.length === 0) return;
    set((state) => {
      const newGeorefMuts = new Map(state.georefMutations);
      const modelMuts = { ...newGeorefMuts.get(modelId) };
      const entityMuts = { ...modelMuts[entity] } as Record<string, unknown>;
      for (const entry of fields) {
        entityMuts[entry.field] = entry.value;
      }
      newGeorefMuts.set(modelId, { ...modelMuts, [entity]: entityMuts });

      // Track undo
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      const nextMutations: Mutation[] = fields.map(entry => ({
        id: `mut_georef_${entity}_${entry.field}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        type: 'UPDATE_ATTRIBUTE',
        timestamp: Date.now(),
        modelId,
        entityId: 0, // georef entities don't map to a specific element
        attributeName: `georef.${entity}.${entry.field}`,
        oldValue: entry.oldValue,
        newValue: entry.value,
        propName: entry.field,
        psetName: entity,
      }));
      newUndoStacks.set(modelId, [...stack, ...nextMutations]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        georefMutations: newGeorefMuts,
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });
  },

  getGeorefMutations: (modelId) => {
    return get().georefMutations.get(modelId);
  },

  // Mutation View Management
  getMutationView: (modelId) => {
    return get().mutationViews.get(modelId) || null;
  },

  registerMutationView: (modelId, view) => {
    set((state) => {
      const newViews = new Map(state.mutationViews);
      newViews.set(modelId, view);
      return { mutationViews: newViews };
    });
  },

  clearMutationView: (modelId) => {
    set((state) => {
      const newViews = new Map(state.mutationViews);
      newViews.delete(modelId);
      const newEditors = new Map(state.storeEditors);
      newEditors.delete(modelId);
      const newDirty = new Set(state.dirtyModels);
      newDirty.delete(modelId);
      const newRemoved = pruneStashByModel(state.removedNewEntities, modelId);
      const newRemovedMeshes = pruneStashByModel(state.removedMeshes, modelId);
      const history = pruneMutationHistory(
        modelId,
        state.undoStacks,
        state.redoStacks,
        state.mutationBatchTags,
        state.mutationMeshTranslations,
      );
      return {
        mutationViews: newViews,
        storeEditors: newEditors,
        dirtyModels: newDirty,
        removedNewEntities: newRemoved,
        removedMeshes: newRemovedMeshes,
        ...history,
      };
    });
  },

  // Property Mutations
  setProperty: (modelId, entityId, psetName, propName, value, valueType = PropertyValueType.String, dataType) => {
    // Collab role gate BEFORE the local commit: in a shared session only
    // editor/admin may write. Gating here (not just at the mirror) keeps the
    // local view/undo/dirty state consistent with what actually syncs — a
    // viewer-role user must not build up local-only edits that silently never
    // reach the room. Single-user sessions (role === null) are unaffected.
    if (!get().canCollabEdit()) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.setProperty(entityId, psetName, propName, value, valueType, undefined, false, dataType);

    set((state) => {
      // Add to undo stack
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      // Clear redo stack on new mutation
      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      // Mark model as dirty
      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    // Mirror into the collab CRDT (no-op without a session, and no-op unless
    // `modelId` is the ROOM's model — the mirror gates itself on the modelId it
    // is handed, so this call site cannot get the subject wrong. See
    // `@/lib/collab/room-model-target`.)
    get().mirrorPropertyEdit(modelId, entityId, psetName, propName, value, valueType);

    return mutation;
  },

  deleteProperty: (modelId, entityId, psetName, propName) => {
    // Collab role gate before the local commit — see setProperty.
    if (!get().canCollabEdit()) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.deleteProperty(entityId, psetName, propName);
    if (!mutation) return null;

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    // Mirror into the collab CRDT — room model only, gated in the callee. See
    // the note in `setProperty`.
    get().mirrorPropertyDelete(modelId, entityId, psetName, propName);

    return mutation;
  },

  createPropertySet: (modelId, entityId, psetName, properties) => {
    // Collab role gate before the local commit — see setProperty. (Pset
    // creation isn't mirrored yet, which is all the more reason a read-only
    // role must not accumulate local-only psets in a shared session.)
    if (!get().canCollabEdit()) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.createPropertySet(entityId, psetName, properties);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  deletePropertySet: (modelId, entityId, psetName) => {
    // Collab role gate before the local commit — see setProperty. Removing a
    // pset is no less of a write than creating one, and this arm was the one
    // `createPropertySet` and `deleteProperty` were both given the gate and
    // this one was not.
    if (!get().canCollabEdit()) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.deletePropertySet(entityId, psetName);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  // Quantity Mutations
  setQuantity: (modelId, entityId, qsetName, quantName, value, quantityType = QuantityType.Count, unit) => {
    // Same gate as setProperty/setAttribute/createPropertySet, for the reason
    // spelled out there: a viewer-role user must not accumulate local-only
    // edits that silently never reach the room. This was missing here, so a
    // read-only participant's quantity edits committed locally, marked the
    // model dirty and entered their undo stack.
    //
    // NOTE the sync half of that comment is NOT yet true for quantities even
    // for an editor: there is no `mirrorQuantityEdit`, and `attachRemoteApply`
    // has no `quantities` arm, so a quantity edit still reaches no peer. That
    // is a separate, larger gap — see the tests below and the PR discussion.
    // Gating here at least stops an unauthorised writer, and stops the local
    // state diverging further than it already does.
    if (!get().canCollabEdit()) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.setQuantity(entityId, qsetName, quantName, value, quantityType, unit);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  createQuantitySet: (modelId, entityId, qsetName, quantities) => {
    // See setQuantity above — same omission, same reason.
    if (!get().canCollabEdit()) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.createQuantitySet(entityId, qsetName, quantities);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  // Attribute Mutations
  setAttribute: (modelId, entityId, attrName, value, oldValue) => {
    // Collab role gate before the local commit — see setProperty.
    if (!get().canCollabEdit()) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.setAttribute(entityId, attrName, value, oldValue);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    // Mirror into the collab CRDT — room model only, gated in the callee. See
    // the note in `setProperty`.
    get().mirrorAttributeEdit(modelId, entityId, attrName, value);

    return mutation;
  },

  // Entity retype (reassign class)
  setEntityType: (modelId, entityId, newType, predefinedType) => {
    // Collab role gate before the local commit — see setProperty. Reclassing an
    // entity is an attribute write like any other, and `setAttribute` is gated.
    if (!get().canCollabEdit()) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    let mutation: Mutation | null = null;
    try {
      mutation = view.setEntityType(entityId, newType, predefinedType ?? null);
    } catch (err) {
      // Invalid class keyword — surface nothing rather than crash the store.
      // The dialog validates before calling, so this only guards stray callers;
      // log it so a programmatic bad value isn't swallowed silently.
      console.warn(`setEntityType(#${entityId} → "${newType}") rejected:`, err);
      return null;
    }

    // Reflect the new class live (inspector, hover, tree on rebuild).
    syncTypeOverride(get, modelId, entityId);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...stack, mutation!]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    return mutation;
  },

  // Store-Level Mutations
  setPositionalAttribute: (modelId, entityId, index, value) => {
    // Collab role gate before the local commit — see setProperty. This is the
    // rawest write in the slice (a direct STEP slot overwrite); every named
    // mutation above it is gated, so leaving this one open gated nothing.
    if (!get().canCollabEdit()) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return null;

    // Capture prior overlay value (if any) for undo. We can't recover the
    // base STEP value from here without parsing the source — that's the
    // RawStepRow's job — so undo of "first override" simply removes the
    // override, falling back to the original buffer value.
    const prior = view.getPositionalMutationsForEntity(entityId)?.get(index);
    editor.setPositionalAttribute(entityId, index, value);

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      const mutation: Mutation = {
        id: `mut_pos_${entityId}_${index}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        type: 'UPDATE_POSITIONAL_ATTRIBUTE',
        timestamp: Date.now(),
        modelId,
        entityId,
        attributeName: `@${index}`,
        oldValue: (prior ?? null) as PropertyValue,
        newValue: value as PropertyValue,
      };
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(state.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: state.mutationVersion + 1,
      };
    });

    // Return the mutation we just pushed onto the undo stack.
    const stack = get().undoStacks.get(modelId);
    return stack ? stack[stack.length - 1] : null;
  },

  setPositionalAttributesBatch: (modelId, updates) => {
    if (updates.length === 0) return null;
    // One batch id for every mutation created below, so the undo / redo
    // handlers group them.
    const batchId = newMutationBatchId();
    const ids: string[] = [];
    for (const { entityId, index, value } of updates) {
      const mutation = get().setPositionalAttribute(modelId, entityId, index, value);
      if (mutation) ids.push(mutation.id);
    }
    get().tagMutationBatch(ids, batchId);
    return batchId;
  },

  recordMutationBatch: (modelId, mutations, batchId) => recordMutationBatch(set, modelId, mutations, batchId),

  tagMutationBatch: (mutationIds, batchId) => {
    if (mutationIds.length === 0) return;
    set((s) => ({ mutationBatchTags: withMutationBatchTags(s.mutationBatchTags, mutationIds, batchId) }));
  },

  translateEntity: (modelId, expressId, delta, batchId) => {
    // Collab role gate: in a shared session only editor/admin may move geometry
    // (single-user sessions have role === null → allowed).
    if (!get().canCollabEdit()) {
      return { ok: false, reason: 'Editing is disabled for your role in this shared session' };
    }
    // Read the existing placement chain WITHOUT committing the edit
    // yet — we'll route the actual write through `setPositionalAttribute`
    // below so undo/redo + dirty-tracking come for free.
    const view = get().mutationViews.get(modelId);
    if (!view) return { ok: false, reason: 'Model has no editable mutation view yet' };
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { ok: false, reason: 'Failed to resolve store editor' };
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return { ok: false, reason: `No model loaded for id "${modelId}"` };

    const chain = resolvePlacementChain(dataStore, view, editor, expressId);
    if (!chain) {
      // No STEP placement chain — e.g. a recipient's IFCX-reconstructed store.
      // Route the move through the collab doc (`usd::xformop`) instead, which
      // syncs to peers and moves the local mesh. Returns false outside a room.
      if (get().collabTranslateEntity(modelId, expressId, delta)) {
        return { ok: true, newCoordinates: delta };
      }
      return {
        ok: false,
        reason:
          'Entity placement is not a simple IfcLocalPlacement → IfcAxis2Placement3D → IfcCartesianPoint chain',
      };
    }
    const [x, y, z] = chain.coordinates;
    const next: [number, number, number] = [x + delta[0], y + delta[1], z + delta[2]];
    // Go through the slice's own `setPositionalAttribute` action so
    // the mutation lands on the undo stack with the standard envelope.
    const mutation = get().setPositionalAttribute(modelId, chain.cartesianPointId, 0, next);

    // Push the renderer-frame delta so the visible mesh follows
    // the IFC mutation. IFC is Z-up; renderer is Y-up. Conversion:
    //   renderer.x =  ifc.x
    //   renderer.y =  ifc.z
    //   renderer.z = -ifc.y
    const globalId = toGlobalIdFromModels(get().models, modelId, expressId);
    const rendererDelta: [number, number, number] = [delta[0], delta[2], -delta[1]];
    get().setPendingMeshTranslations(new Map([[globalId, rendererDelta]]));

    // Record the mesh translation against the mutation id so undo /
    // redo can move the rendered mesh back / forward — the mutation
    // alone only carries the IfcCartesianPoint coordinate change.
    // When a `batchId` is supplied (gizmo drag), tag the mutation so
    // all the drag's per-frame translates collapse to one undo step.
    if (mutation) {
      const meshTags = new Map(get().mutationMeshTranslations);
      meshTags.set(mutation.id, { globalId, rendererDelta });
      if (batchId) {
        const batchTags = new Map(get().mutationBatchTags);
        batchTags.set(mutation.id, batchId);
        set({ mutationMeshTranslations: meshTags, mutationBatchTags: batchTags });
      } else {
        set({ mutationMeshTranslations: meshTags });
      }
    }

    // Mirror the move to peers as the entity's canonical placement
    // (`usd::xformop`). No-op outside a collab session.
    get().mirrorPlacementEdit(modelId, expressId, delta);

    return { ok: true, newCoordinates: next };
  },

  setEntityPosition: (modelId, expressId, position) => {
    if (!get().canCollabEdit()) {
      return { ok: false, reason: 'Editing is disabled for your role in this shared session' };
    }
    const view = get().mutationViews.get(modelId);
    if (!view) return { ok: false, reason: 'Model has no editable mutation view yet' };
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { ok: false, reason: 'Failed to resolve store editor' };
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return { ok: false, reason: `No model loaded for id "${modelId}"` };

    const chain = resolvePlacementChain(dataStore, view, editor, expressId);
    if (!chain) {
      // No STEP chain (recipient/IFCX store): translate by the delta from the
      // current collab placement to the requested absolute position.
      const current = get().readCollabPlacement(modelId, expressId);
      if (current) {
        const delta: [number, number, number] = [
          position[0] - current.location[0],
          position[1] - current.location[1],
          position[2] - current.location[2],
        ];
        if (get().collabTranslateEntity(modelId, expressId, delta)) {
          return { ok: true, newCoordinates: position };
        }
      }
      return {
        ok: false,
        reason:
          'Entity placement is not a simple IfcLocalPlacement → IfcAxis2Placement3D → IfcCartesianPoint chain',
      };
    }
    // Push the IFC → renderer delta for the rendered mesh. Same
    // Z-up → Y-up conversion as `translateEntity` above.
    const [oldX, oldY, oldZ] = chain.coordinates;
    const dx = position[0] - oldX;
    const dy = position[1] - oldY;
    const dz = position[2] - oldZ;
    const mutation = get().setPositionalAttribute(modelId, chain.cartesianPointId, 0, position);
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      const globalId = toGlobalIdFromModels(get().models, modelId, expressId);
      const rendererDelta: [number, number, number] = [dx, dz, -dy];
      get().setPendingMeshTranslations(new Map([[globalId, rendererDelta]]));
      // Record so undo / redo can move the rendered mesh — see the
      // matching note in `translateEntity`.
      if (mutation) {
        const tags = new Map(get().mutationMeshTranslations);
        tags.set(mutation.id, { globalId, rendererDelta });
        set({ mutationMeshTranslations: tags });
      }
      // Mirror the move to peers as the entity's placement (`usd::xformop`).
      get().mirrorPlacementEdit(modelId, expressId, [dx, dy, dz]);
    }
    return { ok: true, newCoordinates: position };
  },

  rotateEntity: (modelId, expressId, deltaYaw) => {
    if (!get().canCollabEdit()) {
      return { ok: false, reason: 'Editing is disabled for your role in this shared session' };
    }
    const view = get().mutationViews.get(modelId);
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (view && dataStore) {
      const editor = getOrCreateStoreEditor(get, set, modelId);
      // resolveRotationState gives the current angle + whether RefDirection is
      // explicit. When implicit we refuse (materialising a fresh IfcDirection
      // needs multi-mutation atomic undo). Every in-store builder emits an
      // explicit RefDirection, so that only trips on hand-rolled entities.
      const state = editor ? resolveRotationState(dataStore, view, editor, expressId) : null;
      if (state && state.refDirectionId === null) {
        return {
          ok: false,
          reason:
            'Entity has an implicit reference direction (no IfcDirection on its axis placement). Rotation would require materialising a new IfcDirection, which isn\'t undoable yet.',
        };
      }
      if (state && state.refDirectionId !== null) {
        const newYaw = state.yawZ + deltaYaw;
        const newRatios: [number, number, number] = [
          Math.cos(newYaw),
          Math.sin(newYaw),
          state.refDirection[2],
        ];
        get().setPositionalAttribute(modelId, state.refDirectionId, 0, newRatios);
        // Live-rotate the rendered mesh about its bbox centre (IFC yaw about Z
        // = renderer yaw about +Y, same angle).
        const globalId = toGlobalIdFromModels(get().models, modelId, expressId);
        const meshes = meshesForOwningModel(get(), modelId);
        const c = getEntityCenter(meshes, globalId);
        if (c) {
          get().setPendingMeshRotations(
            new Map([[globalId, { angle: deltaYaw, pivot: [c.x, c.y, c.z] as [number, number, number] }]]),
          );
        }
        // Mirror to peers as the entity's placement (`usd::xformop` refDirection).
        get().mirrorPlacementEdit(modelId, expressId, [0, 0, 0], deltaYaw);
        return { ok: true, newYawZ: newYaw };
      }
    }
    // No STEP rotation chain (recipient's IFCX-reconstructed store): rotate via
    // the collab doc, which syncs + live-rotates the local mesh.
    if (get().collabRotateEntity(modelId, expressId, deltaYaw)) {
      return { ok: true, newYawZ: deltaYaw };
    }
    return {
      ok: false,
      reason: 'Entity placement is not a simple IfcLocalPlacement → IfcAxis2Placement3D chain',
    };
  },

  readEntityRotation: (modelId, expressId) => {
    // Try the STEP chain only when the view+editor exist; otherwise fall back
    // to the collab placement (recipient's IFCX store) so the rotate card lights
    // up there too — mirrors `readEntityPosition`'s view-independent fallback.
    const view = get().mutationViews.get(modelId);
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (view && dataStore) {
      const editor = getOrCreateStoreEditor(get, set, modelId);
      if (editor) {
        const state = resolveRotationState(dataStore, view, editor, expressId);
        if (state) return { yawZ: state.yawZ, refDirection: state.refDirection };
      }
    }
    const placement = get().readCollabPlacement(modelId, expressId);
    if (placement) {
      const ref = (placement.refDirection ?? [1, 0, 0]) as [number, number, number];
      return { yawZ: Math.atan2(ref[1], ref[0]), refDirection: ref };
    }
    return null;
  },

  readEntityPosition: (modelId, expressId) => {
    // Mirror of `readEntityRotation`'s lazy-create pattern. Used by
    // `GeometryEditCard` to seed its inputs AND by `GizmoOverlay`
    // as its "is this entity movable?" gate — one code path means
    // the controls and the visual gizmo agree on availability.
    //
    // The STEP chain needs the mutation view + editor; but the collab
    // fallback (recipient's IFCX-reconstructed store) reads placement
    // straight from the doc, so it must NOT be gated on the view. A
    // freshly-joined recipient creates its MutablePropertyView lazily
    // *after* first selection, so gating the whole read on the view would
    // hide the gizmo on the first selection. Try the STEP chain when we
    // can, then always offer the collab fallback.
    const view = get().mutationViews.get(modelId);
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (view && dataStore) {
      const editor = getOrCreateStoreEditor(get, set, modelId);
      if (editor) {
        const chain = resolvePlacementChain(dataStore, view, editor, expressId);
        if (chain) return chain.coordinates;
      }
    }
    // No STEP chain (recipient's IFCX-reconstructed store): fall back to the
    // collab placement so the move gizmo + geometry card still surface. The
    // gizmo's origin comes from the mesh bbox, so a [0,0,0] here is fine — this
    // is purely the "is this entity movable?" gate.
    return get().readCollabPlacement(modelId, expressId)?.location ?? null;
  },

  resizeWall: (modelId, expressId, newStart, newEnd) => {
    if (!get().canCollabEdit()) {
      return { ok: false, reason: 'Editing is disabled for your role in this shared session' };
    }
    const view = get().mutationViews.get(modelId);
    if (!view) return { ok: false, reason: 'Model has no editable mutation view yet' };
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { ok: false, reason: 'Failed to resolve store editor' };
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return { ok: false, reason: `No model loaded for id "${modelId}"` };

    // resolveWallEditChain reads all four ids without mutating.
    // The four writes are then committed as a single atomic batch
    // via setPositionalAttributesBatch — one Ctrl+Z reverts the
    // whole resize, no walking through inconsistent intermediate
    // wall states.
    const chain = resolveWallEditChain(dataStore, view, editor, expressId);
    if (!chain) {
      return {
        ok: false,
        reason:
          'Wall does not have a simple IfcRectangleProfileDef → IfcExtrudedAreaSolid representation',
      };
    }
    const dx = newEnd[0] - newStart[0];
    const dy = newEnd[1] - newStart[1];
    const dz = newEnd[2] - newStart[2];
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return { ok: false, reason: 'Wall length must be greater than zero' };
    if (Math.abs(dz) > Math.max(1e-6 * length, 1e-9)) {
      return { ok: false, reason: 'Start and end must lie on the same storey plane' };
    }
    const dir: [number, number, number] = [dx / length, dy / length, 0];

    get().setPositionalAttributesBatch(modelId, [
      { entityId: chain.startPointId, index: 0, value: newStart },
      { entityId: chain.refDirectionId, index: 0, value: dir },
      { entityId: chain.profileId, index: 3, value: length },
      { entityId: chain.profileOriginPointId, index: 0, value: [length / 2, 0] },
    ]);

    // Mirror the resize to peers as a geometry replace: regenerate the wall mesh
    // at the new dimensions (built at its current world position) and swap the
    // entity's room blob. The owner's own mesh is unchanged here (resize is
    // data-only locally today); peers re-hydrate the new blob. No-op off-collab.
    if (Number.isFinite(chain.height) && chain.height > 0) {
      const globalId = toGlobalIdFromModels(get().models, modelId, expressId);
      const meshes = meshesForOwningModel(get(), modelId);
      const bounds = getEntityBounds(meshes, globalId);
      const newMesh = buildElementMesh({
        type: 'wall',
        globalId,
        storeyElevation: bounds?.min.y ?? 0, // renderer Y base = IFC Z storey elevation
        payload: {
          type: 'wall',
          params: { Thickness: chain.thickness, Height: chain.height },
          start: newStart,
          end: newEnd,
        },
      });
      if (newMesh) get().mirrorEntityGeometry(modelId, expressId, newMesh);
    }

    return { ok: true, newLength: length };
  },

  readWallEndpoints: (modelId, expressId) => {
    // Same lazy-create pattern as `readEntityRotation` /
    // `readEntityPosition` — handles need to surface on first
    // selection, not after an unrelated mutation has primed the
    // editor cache.
    const view = get().mutationViews.get(modelId);
    if (!view) return null;
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return null;
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return null;
    const chain = resolveWallEditChain(dataStore, view, editor, expressId);
    if (!chain) return null;
    const [sx, sy, sz] = chain.startCoordinates;
    const [dx, dy, dz] = chain.refDirection;
    const end: [number, number, number] = [
      sx + dx * chain.wallLength,
      sy + dy * chain.wallLength,
      sz + dz * chain.wallLength,
    ];
    return { start: [sx, sy, sz], end, thickness: chain.thickness };
  },

  readWallSplitProjection: (modelId, expressId, cursorStoreyLocal) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return null;
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return null;
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return null;
    const chain = resolveWallEditChain(dataStore, view, editor, expressId);
    if (!chain) return null;
    const distance = projectOntoWallAxis(chain, cursorStoreyLocal);
    const [sx, sy, sz] = chain.startCoordinates;
    const [dx, dy, dz] = chain.refDirection;
    const cutPoint: [number, number, number] = [
      sx + dx * distance,
      sy + dy * distance,
      sz + dz * distance,
    ];
    // Walls always lie on a storey plane (refDirection.z === 0 by
    // the builder's contract) but the type lets us carry whatever
    // the IFC actually says, so we surface it as-is.
    return { distance, length: chain.wallLength, cutPoint, axis: [dx, dy, dz] };
  },

  splitWallAtDistance: (modelId, expressId, distanceFromStart) => {
    // Collab role gate — same rule and same return shape as `resizeWall`.
    if (!get().canCollabEdit()) {
      return { ok: false, reason: 'Editing is disabled for your role in this shared session' };
    }
    const ctx = resolveSplitContext(get, set, modelId, expressId, 'Wall is not contained in a building storey');
    if ('ok' in ctx) return ctx;
    const { view, editor, dataStore, storeyExpressId } = ctx;
    const state = get();

    const chain = resolveWallEditChain(dataStore, view, editor, expressId);
    if (!chain) {
      return {
        ok: false,
        reason:
          'Wall does not have a simple IfcRectangleProfileDef → IfcExtrudedAreaSolid representation. Split supports walls built by addWallToStore.',
      };
    }
    if (!Number.isFinite(chain.height) || chain.height <= 0) {
      return {
        ok: false,
        reason: 'Wall has no readable extrusion height',
      };
    }

    const geo = computeWallSplitGeometry(chain, distanceFromStart, chain.height);
    if (!geo.ok) return geo;

    // Build the two halves. Each `addWall` call already pushes a
    // CREATE_ENTITY mutation onto the undo stack AND emits a fresh
    // mesh via appendGeometryBatch, so the new walls appear in 3D
    // immediately. The source's mesh stays in the geometry result
    // but is tombstoned in the IFC overlay — for v1 we mark it
    // hidden via the existing hiddenEntities mechanism so the user
    // sees the split take effect.
    const left = state.addWall(modelId, storeyExpressId, {
      Start: geo.geometry.left.Start,
      End: geo.geometry.left.End,
      Thickness: geo.geometry.left.Thickness,
      Height: geo.geometry.left.Height,
      Name: 'Wall (split L)',
    });
    if ('error' in left) {
      return { ok: false, reason: `Couldn't build left half: ${left.error}` };
    }
    const right = state.addWall(modelId, storeyExpressId, {
      Start: geo.geometry.right.Start,
      End: geo.geometry.right.End,
      Thickness: geo.geometry.right.Thickness,
      Height: geo.geometry.right.Height,
      Name: 'Wall (split R)',
    });
    if ('error' in right) {
      // Roll back the left half via the no-history helper so the
      // failed split doesn't leave a phantom CREATE+DELETE pair on
      // the undo stack. `rollbackOverlayCreate` pops the orphan
      // CREATE_ENTITY entry, drops the overlay record, and removes
      // the renderer mesh.
      rollbackOverlayCreate(get, set, modelId, left.expressId);
      return { ok: false, reason: `Couldn't build right half: ${right.error}` };
    }

    // Carry Pset / Qto / classification / material / type rels
    // from the source onto both new walls. Done AFTER the new walls
    // exist so the rels' RelatedObjects lists can include them.
    cloneElementMetadata(dataStore, view, editor, expressId, [left.expressId, right.expressId]);

    // Reassign hosted openings (doors / windows / generic voids)
    // to whichever new half they geometrically belong to. The
    // canonical IFC convention places the opening's
    // ObjectPlacement relative to the wall's placement, with
    // local-X = distance along the wall axis — so we read each
    // opening's local-X to decide left vs right, and offset
    // right-half openings by -splitDistance so their world
    // positions stay fixed across the reparent.
    //
    // We resolve each new half's IfcLocalPlacement id by
    // re-walking the placement chain (it's the entity addWall
    // created internally; the action's return value only carries
    // the wall id).
    const leftChain = resolvePlacementChain(dataStore, view, editor, left.expressId);
    const rightChain = resolvePlacementChain(dataStore, view, editor, right.expressId);
    let openingSummary: { toLeft: number; toRight: number; skipped: number } = { toLeft: 0, toRight: 0, skipped: 0 };
    if (leftChain && rightChain) {
      const s = reassignWallOpenings(
        dataStore,
        view,
        editor,
        expressId,
        left.expressId,
        right.expressId,
        distanceFromStart,
        leftChain.localPlacementId,
        rightChain.localPlacementId,
      );
      openingSummary = { toLeft: s.toLeft, toRight: s.toRight, skipped: s.skipped };
    }
    void openingSummary; // surfaced as a toast hint by the caller (selectionHandlers)

    // Tombstone the source. `removeEntity` returns false if the
    // entity wasn't known — shouldn't happen here (we just
    // resolved its chain), but defend anyway.
    const removed = state.removeEntity(modelId, expressId);
    if (!removed) {
      return {
        ok: false,
        reason: 'Wall was unexpectedly removed before split completed',
      };
    }

    // `removeEntity` above already dropped the source's mesh out of the
    // geometry (stashed for undo) and queued the renderer-side removal.
    // The two new walls already have their meshes via appendGeometryBatch.
    const leftGlobalId = toGlobalIdFromModels(state.models, modelId, left.expressId);
    const rightGlobalId = toGlobalIdFromModels(state.models, modelId, right.expressId);

    return {
      ok: true,
      left: { expressId: left.expressId, globalId: leftGlobalId },
      right: { expressId: right.expressId, globalId: rightGlobalId },
      openings: openingSummary,
    };
  },

  readLinearElementSplitProjection: (modelId, expressId, cursorStoreyLocal) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return null;
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return null;
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return null;
    const chain = resolveLinearElementChain(dataStore, view, editor, expressId);
    if (!chain) return null;
    const distance = projectOntoLinearAxis(chain, cursorStoreyLocal);
    const [sx, sy, sz] = chain.startCoordinates;
    const [dx, dy, dz] = chain.axisDirection;
    const cutPoint: [number, number, number] = [
      sx + dx * distance,
      sy + dy * distance,
      sz + dz * distance,
    ];
    return {
      distance,
      length: chain.depth,
      cutPoint,
      axis: chain.axisDirection,
      elementType: chain.elementType,
    };
  },

  splitLinearElementAtDistance: (modelId, expressId, distanceFromStart) => {
    // Collab role gate — same rule and same return shape as `resizeWall`.
    if (!get().canCollabEdit()) {
      return { ok: false, reason: 'Editing is disabled for your role in this shared session' };
    }
    const ctx = resolveSplitContext(get, set, modelId, expressId, 'Element is not contained in a building storey');
    if ('ok' in ctx) return ctx;
    const { view, editor, dataStore, storeyExpressId } = ctx;
    const state = get();

    const chain = resolveLinearElementChain(dataStore, view, editor, expressId);
    if (!chain) {
      return {
        ok: false,
        reason:
          'Element is not a rectangular-profile beam / column / member built by the in-store builders.',
      };
    }
    const geo = computeLinearElementSplitGeometry(chain, distanceFromStart);
    if (!geo.ok) return geo;

    // Add the "right" half FIRST so a builder failure leaves the
    // source untouched (no partial-commit state). The source's
    // extrusion shrink happens only after the new half lands.
    // The dispatch is one-to-one with the chain's resolved
    // element type.
    let addResult: { expressId: number } | { error: string };
    if (chain.elementType === 'IfcBeam') {
      addResult = state.addBeam(modelId, storeyExpressId, {
        Start: geo.geometry.cutPoint,
        End: geo.geometry.endPoint,
        Width: geo.geometry.width,
        Height: geo.geometry.height,
        Name: 'Beam (split)',
      });
    } else if (chain.elementType === 'IfcColumn') {
      // Columns take a Position + Width + Depth + Height (extrusion
      // is along +Z). Width/Depth come from the cross-section
      // (profile XDim / YDim). Height is the right half's length.
      addResult = state.addColumn(modelId, storeyExpressId, {
        Position: geo.geometry.cutPoint,
        Width: geo.geometry.width,
        Depth: geo.geometry.height,
        Height: geo.geometry.rightDepth,
        Name: 'Column (split)',
      });
    } else {
      addResult = state.addMember(modelId, storeyExpressId, {
        Start: geo.geometry.cutPoint,
        End: geo.geometry.endPoint,
        Width: geo.geometry.width,
        Height: geo.geometry.height,
        Name: 'Member (split)',
      });
    }
    if ('error' in addResult) {
      return { ok: false, reason: `Couldn't build right half: ${addResult.error}` };
    }

    // Right half built — now shrink the source's extrusion to the
    // "left" length. One write, one undo entry, identity
    // preserved. Goes through the slice's own
    // setPositionalAttribute action so undo recovers it.
    state.setPositionalAttribute(modelId, chain.extrudedSolidId, 3, geo.geometry.leftDepth);

    // Carry Pset / classification / material rels onto the new
    // right half so it inherits the source's metadata. The source
    // keeps its own rels natively (we didn't tombstone it).
    cloneElementMetadata(dataStore, view, editor, expressId, [addResult.expressId]);

    // Hide / re-show the source's mesh so the renderer reflects
    // the new shorter length. The new mesh for the right half
    // already came via the addElement pipeline's appendGeometryBatch.
    // For the source, the easiest visual update is to nudge the
    // geometryUpdateTick so consumers re-derive bounds — the
    // existing mesh data lingers at full length until the next
    // full reload (deferred mesh-update from PR #723). Users see
    // the new wall appear; the source mesh stays visually unchanged
    // for now. Documented as a known limitation.
    const sourceGlobalId = toGlobalIdFromModels(state.models, modelId, expressId);
    const rightGlobalId = toGlobalIdFromModels(state.models, modelId, addResult.expressId);

    return {
      ok: true,
      source: { expressId, globalId: sourceGlobalId },
      right: { expressId: addResult.expressId, globalId: rightGlobalId },
    };
  },

  readSlabFootprint: (modelId, expressId) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return null;
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return null;
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return null;
    const chain = resolveSlabEditChain(dataStore, view, editor, expressId, getModelLengthUnitScale(dataStore));
    if (!chain) return null;
    const storeyId = dataStore.spatialHierarchy?.elementToStorey.get(expressId);
    const storeyElevation =
      (storeyId !== undefined
        ? dataStore.spatialHierarchy?.storeyElevations?.get(storeyId)
        : undefined) ?? 0;
    return {
      footprint: chain.footprint,
      elementType: chain.elementType,
      storeyElevation,
      thickness: chain.thickness,
    };
  },

  splitSlabByLine: (modelId, expressId, cutA, cutB) => {
    // Collab role gate — same rule and same return shape as `resizeWall`.
    if (!get().canCollabEdit()) {
      return { ok: false, reason: 'Editing is disabled for your role in this shared session' };
    }
    const ctx = resolveSplitContext(get, set, modelId, expressId, 'Slab is not contained in a building storey');
    if ('ok' in ctx) return ctx;
    const { view, editor, dataStore, storeyExpressId } = ctx;
    const state = get();

    const chain = resolveSlabEditChain(dataStore, view, editor, expressId, getModelLengthUnitScale(dataStore));
    if (!chain) {
      return {
        ok: false,
        reason:
          'Element representation is not a rectangle / polygon profile extruded along Z. Split supports slab-like elements built by addSlab / addRoof / addPlate / addSpace.',
      };
    }
    const geo = computeSlabSplitGeometry(chain, cutA, cutB);
    if (!geo.ok) return geo;

    // The clipped footprints are in storey-local XY (placement
    // origin already added). The builders expect an `OuterCurve`
    // in *profile-local* 2D + a `Position` in storey-local 3D.
    // Easiest mapping: keep `Position` at `[0, 0, 0]` and pass the
    // clipped polygon verbatim — the builders fold profile-origin
    // and placement-origin into one identity.
    //
    // IfcSlab / IfcRoof / IfcPlate carry their extrusion depth on
    // a `Thickness` param; IfcSpace uses `Height`. Same chain
    // resolver feeds both because the underlying STEP shape is
    // identical (IfcExtrudedAreaSolid.Depth) — the divergence is
    // only in the in-store builder's parameter naming.
    const buildHalf = (outline: Point2D[], label: string) => {
      const name = `${chain.elementType.replace(/^Ifc/, '')} (split ${label})`;
      switch (chain.elementType) {
        case 'IfcSlab':
          return state.addSlab(modelId, storeyExpressId, {
            Profile: 'polygon',
            Position: [0, 0, 0],
            OuterCurve: outline,
            Thickness: geo.thickness,
            Name: name,
          });
        case 'IfcRoof':
          return state.addRoof(modelId, storeyExpressId, {
            Profile: 'polygon',
            Position: [0, 0, 0],
            OuterCurve: outline,
            Thickness: geo.thickness,
            Name: name,
          });
        case 'IfcPlate':
          return state.addPlate(modelId, storeyExpressId, {
            Profile: 'polygon',
            Position: [0, 0, 0],
            OuterCurve: outline,
            Thickness: geo.thickness,
            Name: name,
          });
        case 'IfcSpace':
          return state.addSpace(modelId, storeyExpressId, {
            Profile: 'polygon',
            Position: [0, 0, 0],
            OuterCurve: outline,
            Height: geo.thickness,
            Name: name,
          });
        default: {
          // Exhaustive switch — compile error here if a new
          // SlabLikeType lands without a builder dispatch.
          const exhaust: never = chain.elementType;
          throw new Error(`Unhandled slab-like type: ${String(exhaust)}`);
        }
      }
    };

    const left = buildHalf(geo.leftFootprint, 'L');
    if ('error' in left) {
      return { ok: false, reason: `Couldn't build left half: ${left.error}` };
    }
    const right = buildHalf(geo.rightFootprint, 'R');
    if ('error' in right) {
      // Roll back the left half via the no-history helper — same
      // reasoning as the wall-split rollback above.
      rollbackOverlayCreate(get, set, modelId, left.expressId);
      return { ok: false, reason: `Couldn't build right half: ${right.error}` };
    }

    cloneElementMetadata(dataStore, view, editor, expressId, [left.expressId, right.expressId]);

    const removed = state.removeEntity(modelId, expressId);
    if (!removed) {
      return {
        ok: false,
        reason: 'Slab was unexpectedly removed before split completed',
      };
    }

    // `removeEntity` above already dropped the source's mesh out of the
    // geometry (stashed for undo) and queued the renderer-side removal.
    // The two new halves already have meshes via addSlab's appendGeometryBatch.
    const leftGlobalId = toGlobalIdFromModels(state.models, modelId, left.expressId);
    const rightGlobalId = toGlobalIdFromModels(state.models, modelId, right.expressId);
    return {
      ok: true,
      left: { expressId: left.expressId, globalId: leftGlobalId },
      right: { expressId: right.expressId, globalId: rightGlobalId },
    };
  },

  removeEntity: (modelId, expressId, opts) => {
    if (!get().canCollabEdit()) return false;
    const view = get().mutationViews.get(modelId);
    if (!view) return false;
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return false;

    // Stash the overlay record (if any) BEFORE the editor forgets it, so
    // undo can re-add the exact same NewEntity. For source-buffer entities
    // there's nothing to stash — undo just removes the tombstone.
    const overlayRecord = view.getNewEntity(expressId);
    const removed = editor.removeEntity(expressId);
    if (!removed) return false;

    recordEntityRemovalIn(get, set, modelId, expressId, overlayRecord);

    // Mirror the tombstone to peers (no-op outside a collab session). Callers
    // whose create+delete pair isn't synced yet pass `{ mirror: false }` so
    // only fully-synced deletions propagate.
    if (opts?.mirror !== false) get().mirrorEntityRemove(modelId, expressId);

    return true;
  },

  recordEntityRemoval: (modelId, expressId, overlayRecord) => {
    recordEntityRemovalIn(get, set, modelId, expressId, overlayRecord);
  },

  addColumn: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'column', params },
    (editor, anchor) => addColumnToStore(editor, anchor, params).columnId,
  ),

  addWall: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'wall', params },
    (editor, anchor) => addWallToStore(editor, anchor, params).wallId,
  ),

  addSlab: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'slab', params },
    (editor, anchor) => addSlabToStore(editor, anchor, params).slabId,
  ),

  addBeam: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'beam', params },
    (editor, anchor) => addBeamToStore(editor, anchor, params).beamId,
  ),

  addDoor: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'door', params },
    (editor, anchor) => addDoorToStore(editor, anchor, params).doorId,
  ),

  addWindow: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'window', params },
    (editor, anchor) => addWindowToStore(editor, anchor, params).windowId,
  ),

  addSpace: (modelId, storeyExpressId, params, previewCorners) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'space', params, previewCorners },
    (editor, anchor) => addSpaceToStore(editor, anchor, params).spaceId,
  ),

  addRoof: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'roof', params },
    (editor, anchor) => addRoofToStore(editor, anchor, params).roofId,
  ),

  addPlate: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'plate', params },
    (editor, anchor) => addPlateToStore(editor, anchor, params).plateId,
  ),

  addMember: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'member', params },
    (editor, anchor) => addMemberToStore(editor, anchor, params).memberId,
  ),

  recordAuthoredElement: (modelId, storeyExpressId, entityId, element) => {
    const dataStore = authoredDataStore(get(), modelId);
    const view = get().mutationViews.get(modelId);
    if (!dataStore || !view) return;
    recordAuthoredElementIn(get, set, modelId, dataStore, view, storeyExpressId, entityId, element);
  },

  generateSpacesFromWalls: (modelId, storeyExpressId, options) => {
    const state = get();
    const model = state.models.get(modelId);
    const dataStore = model?.ifcDataStore;
    if (!dataStore) return { error: `No model loaded for id "${modelId}"` };
    const view = state.mutationViews.get(modelId);
    if (!view) return { error: 'Model has no editable mutation view yet' };

    // For dryRun the editor isn't strictly needed — we still create
    // one (cheap) so the helper signature can stay uniform.
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { error: 'Failed to create store editor' };

    let result: GenerateSpacesResult;
    try {
      result = generateSpacesFromWalls(
        editor,
        dataStore,
        storeyExpressId,
        options,
        // The view exposes getNewEntities — pass it in so overlay-only
        // walls (placed via the Add Element tool) participate in the
        // detection without needing a flush to STEP first.
        {
          getNewEntities: () => view.getNewEntities(),
          isDeleted: (id) => view.isDeleted(id),
          getTypeMutations: () => view.getTypeMutations(),
          getPositionalMutationsForEntity: (id) => view.getPositionalMutationsForEntity(id),
        },
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to generate spaces' };
    }

    // dryRun → nothing emitted; skip undo / dirty bookkeeping.
    if (!result.emitted.length) return result;

    set((s) => {
      const newUndoStacks = new Map(s.undoStacks);
      const stack = [...(newUndoStacks.get(modelId) ?? [])];
      const ts = Date.now();
      for (const e of result.emitted) {
        stack.push({
          id: `mut_ifcspace_${e.result.spaceId}_${ts}_${Math.random().toString(36).substring(2, 9)}`,
          type: 'CREATE_ENTITY',
          timestamp: ts,
          modelId,
          entityId: e.result.spaceId,
          attributeName: 'IFCSPACE',
        });
      }
      newUndoStacks.set(modelId, stack);

      const newRedoStacks = new Map(s.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(s.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: s.mutationVersion + 1,
      };
    });

    return result;
  },

  duplicateEntity: (modelId, sourceExpressId, direction = DUPLICATE_DEFAULT_DIRECTION, options) => {
    // Gate before the local commit, as addElementViaBuilder does for creates.
    if (!get().canCollabEdit()) return { error: 'Editing is disabled for your role in this shared session' };
    const state = get();
    const model = state.models.get(modelId);
    const dataStore = model?.ifcDataStore;
    if (!dataStore) return { error: `No model loaded for id "${modelId}"` };

    const view = state.mutationViews.get(modelId);
    if (!view) return { error: 'Model has no editable mutation view yet' };

    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { error: 'Failed to create store editor' };

    // Source's bounding box drives the offset magnitude; meshes are keyed by globalId, so they must
    // come from the EDITED model, not the active model's top-level mirror (#4929).
    // Read in the MODEL frame, not the live baked bytes: the rotation bake turns the appended copy once (#4873).
    const sourceGlobalId = toGlobalIdFromModels(state.models, modelId, sourceExpressId);
    const meshes = meshesForOwningModel(state, modelId)?.filter((m) => m.expressId === sourceGlobalId).map((m) => modelRotationBaker.inModelFrame(m));
    const sourceBounds = getEntityBounds(meshes ?? null, sourceGlobalId);
    const bbox: ViewerBox = sourceBounds
      ? {
          size: {
            x: Math.max(sourceBounds.max.x - sourceBounds.min.x, 0),
            y: Math.max(sourceBounds.max.y - sourceBounds.min.y, 0),
            z: Math.max(sourceBounds.max.z - sourceBounds.min.z, 0),
          },
        }
      : { size: { x: DUPLICATE_FALLBACK_STEP, y: DUPLICATE_FALLBACK_STEP, z: DUPLICATE_FALLBACK_STEP } };

    const ifcDelta = ifcOffsetForDirection(direction, bbox);
    const viewerDelta = viewerDeltaFromIfc(ifcDelta);

    let newId: number;
    try {
      const source = resolveDuplicateSource(dataStore, sourceExpressId, editor);
      const result = duplicateInStore(editor, source, { ...options, offset: ifcDelta });
      newId = result.newId;
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to duplicate' };
    }

    // Alias the duplicate to its source for base property / quantity
    // reads — so the property panel shows the source's psets without
    // us eagerly cloning them. The duplicate's own override slots
    // remain scoped to the new id.
    view.setEntityAlias(newId, sourceExpressId);

    const newGlobalId = toGlobalIdFromModels(state.models, modelId, newId);

    // Mirror the source's meshes into the geometry result with the
    // offset applied so the duplicate is visible immediately. Without
    // this the entity exists only in the export overlay — STEP-correct
    // but invisible — and the user can't tell anything happened.
    const clonedMeshes = cloneMeshesWithOffset(meshes, sourceGlobalId, newGlobalId, viewerDelta);

    set((s) => {
      const newUndoStacks = new Map(s.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      const mutation: Mutation = {
        id: `mut_dup_${newId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        type: 'CREATE_ENTITY',
        timestamp: Date.now(),
        modelId,
        entityId: newId,
        attributeName: 'DUPLICATE',
      };
      newUndoStacks.set(modelId, [...stack, mutation]);

      const newRedoStacks = new Map(s.redoStacks);
      newRedoStacks.set(modelId, []);

      const newDirty = new Set(s.dirtyModels);
      newDirty.add(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        mutationVersion: s.mutationVersion + 1,
      };
    });

    // Append cloned meshes via the existing data slice action so the
    // renderer picks them up via its standard tick.
    if (clonedMeshes.length > 0) {
      const cross = get() as unknown as {
        appendGeometryBatch?: (modelId: string, batch: MeshData[]) => void;
      };
      cross.appendGeometryBatch?.(modelId, clonedMeshes);
      // #4970: inModelFrame leaves alignment baked in; correct the slot.
      applyDuplicatePreAlignmentBaseline(set, modelId, sourceGlobalId, clonedMeshes.length, viewerDelta);
      revealAddedGeometryInModelView(get);
    }

    return { expressId: newId, globalId: newGlobalId };
  },

  // Undo/Redo
  undo: (modelId) => replayHistory(get, set, api, modelId, 'undo'),

  redo: (modelId) => replayHistory(get, set, api, modelId, 'redo'),

  canUndo: (modelId) => {
    const stack = get().undoStacks.get(modelId);
    return stack ? stack.length > 0 : false;
  },

  canRedo: (modelId) => {
    const stack = get().redoStacks.get(modelId);
    return stack ? stack.length > 0 : false;
  },

  invalidateHistoryForEntity: (modelId, entityId) => set((s) => invalidateHistoryPatch(s.undoStacks, s.redoStacks, s.mutationBatchTags, s.mutationMeshTranslations, modelId, entityId)),
  // Change Sets
  createChangeSet: (name) => {
    const id = generateChangeSetId();
    const changeSet: ChangeSet = {
      id,
      name,
      createdAt: Date.now(),
      mutations: [],
      applied: false,
    };

    set((state) => {
      const newChangeSets = new Map(state.changeSets);
      newChangeSets.set(id, changeSet);
      return { changeSets: newChangeSets, activeChangeSetId: id };
    });

    return id;
  },

  getActiveChangeSet: () => {
    const state = get();
    if (!state.activeChangeSetId) return null;
    return state.changeSets.get(state.activeChangeSetId) || null;
  },

  setActiveChangeSet: (id) => {
    set({ activeChangeSetId: id });
  },

  exportChangeSet: (id) => {
    const changeSet = get().changeSets.get(id);
    if (!changeSet) return null;

    return JSON.stringify({
      version: 1,
      changeSet,
      exportedAt: Date.now(),
    }, null, 2);
  },

  importChangeSet: (json) => {
    try {
      const data = JSON.parse(json);
      if (!data.changeSet) return;

      const changeSet: ChangeSet = {
        ...data.changeSet,
        id: generateChangeSetId(),
        applied: false,
      };

      set((state) => {
        const newChangeSets = new Map(state.changeSets);
        newChangeSets.set(changeSet.id, changeSet);
        return { changeSets: newChangeSets };
      });
    } catch {
      console.error('Failed to import change set');
    }
  },

  // Query
  hasChanges: (modelId) => {
    if (get().dirtyModels.has(modelId)) return true;
    // Schedule-only case: a generated schedule OR an edited parsed
    // schedule counts as a pending edit even if the user hasn't touched
    // any properties.
    const cross = get() as unknown as {
      scheduleSourceModelId?: string | null;
      scheduleIsEdited?: boolean;
      scheduleData?: { tasks: Array<{ expressId?: number }> } | null;
    };
    if (cross.scheduleSourceModelId !== modelId) return false;
    if (cross.scheduleIsEdited) return true;
    const tasks = cross.scheduleData?.tasks;
    if (!tasks) return false;
    for (const t of tasks) if (!t.expressId || t.expressId <= 0) return true;
    return false;
  },

  getMutationsForModel: (modelId) => {
    const view = get().mutationViews.get(modelId);
    return view ? view.getMutations() : [];
  },

  getModifiedEntityCount: () => {
    let count = 0;
    for (const view of get().mutationViews.values()) {
      count += view.getModifiedEntityCount();
    }
    // Include models with georef-only edits
    for (const [modelId, gm] of get().georefMutations) {
      const hasGeoref = (gm.projectedCRS && Object.keys(gm.projectedCRS).length > 0)
        || (gm.mapConversion && Object.keys(gm.mapConversion).length > 0);
      if (hasGeoref && !get().mutationViews.has(modelId)) {
        count += 1; // count the model as having modifications
      }
    }
    // Include generated schedule tasks — these are spliced into the STEP
    // export just like property mutations are, so they belong in the same
    // "pending changes" count the export badge reads.
    //
    // Edited parsed schedules: if the schedule has been edited (any task
    // renamed / rescheduled / deleted / etc.) count +1 to surface the
    // badge, even when no generated tasks exist. Users need some signal
    // that "edits are pending export"; a single +1 keeps the count
    // honest without inflating for every individual field change.
    const cross = get() as unknown as {
      scheduleData?: { tasks: Array<{ expressId?: number }> } | null;
      scheduleIsEdited?: boolean;
    };
    const tasks = cross.scheduleData?.tasks;
    let hasGenerated = false;
    if (tasks) {
      for (const t of tasks) {
        if (!t.expressId || t.expressId <= 0) {
          count++;
          hasGenerated = true;
        }
      }
    }
    if (cross.scheduleIsEdited && !hasGenerated) count++;
    return count;
  },

  // Reset
  clearMutations: (modelId) => {
    const view = get().mutationViews.get(modelId);
    if (view) {
      view.clear();
    }

    // Also discard pending schedule edits owned by this model. Done via
    // the schedule slice's own action so its invariants (range, playback,
    // expanded rows) stay consistent.
    const cross = get() as unknown as {
      scheduleSourceModelId?: string | null;
      clearGeneratedSchedule?: () => number;
    };
    if (cross.scheduleSourceModelId === modelId && cross.clearGeneratedSchedule) {
      cross.clearGeneratedSchedule();
    }

    set((state) => {
      const newUndoStacks = new Map(state.undoStacks);
      newUndoStacks.delete(modelId);

      const newRedoStacks = new Map(state.redoStacks);
      newRedoStacks.delete(modelId);

      const newDirty = new Set(state.dirtyModels);
      newDirty.delete(modelId);

      const newGeorefMuts = new Map(state.georefMutations);
      newGeorefMuts.delete(modelId);

      const newRemoved = pruneStashByModel(state.removedNewEntities, modelId);
      const newRemovedMeshes = pruneStashByModel(state.removedMeshes, modelId);

      const newEditors = new Map(state.storeEditors);
      newEditors.delete(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        georefMutations: newGeorefMuts,
        removedNewEntities: newRemoved,
        removedMeshes: newRemovedMeshes,
        storeEditors: newEditors,
        mutationVersion: state.mutationVersion + 1,
      };
    });
  },

  clearAllMutations: () => {
    for (const view of get().mutationViews.values()) {
      view.clear();
    }

    // Schedule slice handles its own state transitions.
    const cross = get() as unknown as { clearGeneratedSchedule?: () => number };
    cross.clearGeneratedSchedule?.();

    set((state) => ({
      undoStacks: new Map(),
      redoStacks: new Map(),
      dirtyModels: new Set(),
      georefMutations: new Map(),
      removedNewEntities: new Map(),
      removedMeshes: new Map(),
      storeEditors: new Map(),
      mutationVersion: state.mutationVersion + 1,
    }));
  },

  bumpMutationVersion: () => {
    set((state) => ({
      mutationVersion: state.mutationVersion + 1,
    }));
  },

  markModelsDirty: (modelIds) => {
    if (modelIds.length === 0) return;
    set((state) => {
      const newDirty = new Set(state.dirtyModels);
      // A bulk edit invalidates the redo branch just like a single edit.
      const newRedo = new Map(state.redoStacks);
      for (const id of modelIds) {
        newDirty.add(id);
        newRedo.set(id, []);
      }
      return {
        dirtyModels: newDirty,
        redoStacks: newRedo,
        mutationVersion: state.mutationVersion + 1,
      };
    });
  },
});
