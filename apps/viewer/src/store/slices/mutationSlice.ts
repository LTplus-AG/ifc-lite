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
import { EntityExtractor, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { getEntityBounds, getEntityCenter } from '@/utils/viewportUtils';
import { toGlobalIdFromModels } from '../globalId.js';
import { buildElementMesh, type ElementMeshPayload } from './addElementMeshes.js';
import type { AddElementType } from './addElementSlice.js';
import type { TypeViewMode } from '../constants.js';
import {
  resolvePlacementChain,
  resolveRotationState,
  rotateProductYaw,
  resolveWallEditChain,
  resizeRectangleWall,
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

export interface MutationSlice {
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
    valueType?: PropertyValueType
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
  /**
   * Tombstone an entity (existing source entity) or forget it (overlay-only).
   * Returns true if the entity was known to the store or overlay.
   */
  removeEntity: (modelId: string, expressId: number, opts?: { mirror?: boolean }) => boolean;
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
    params: SpaceInStoreParams
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
  /**
   * Auto-generate IfcSpace volumes for every enclosed area formed by
   * the storey's walls (existing + overlay). When `dryRun: true` the
   * detection runs but no IfcSpace is emitted — useful for live UI
   * previews.
   */
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
}

function generateChangeSetId(): string {
  return `cs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get-or-create the per-model `StoreEditor`. The editor pairs a parsed
 * `IfcDataStore` with a `MutablePropertyView`; both must already exist
 * (the data store comes from `models`, the view from PropertiesPanel's
 * lazy-init effect). Returns null if either is missing.
 */
/**
 * Push the overlay's effective class for an entity into the model's
 * EntityTable as an additive display override, so a UI retype reflects
 * immediately in the inspector, hover, and the (mutationVersion-rebuilt)
 * hierarchy tree. Reads the current overlay, so it also clears the override
 * on undo (removeTypeMutation → null) and re-applies it on redo.
 */
function syncTypeOverride(get: () => ViewerState, modelId: string, entityId: number): void {
  const view = get().mutationViews.get(modelId);
  const newType = view?.getEntityTypeMutation?.(entityId)?.newType ?? null;
  const dataStore = get().models.get(modelId)?.ifcDataStore ?? get().ifcDataStore;
  dataStore?.entities?.setTypeOverride?.(entityId, newType);
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
 * IfcBuildingStorey.ObjectPlacement is optional in the schema —
 * some authoring tools leave it null when the file was never
 * meant to host geometry. Authoring actions need a placement to
 * anchor their new entities against, so we materialise a default
 * IfcLocalPlacement at the storey's elevation when one's missing
 * and patch the storey's attribute via the overlay.
 *
 * Idempotent: if the storey already has a placement (number or
 * `#X` string ref), this is a no-op. Returns true when a
 * placement was created.
 */
function ensureStoreyPlacement(
  dataStore: import('@ifc-lite/parser').IfcDataStore,
  editor: StoreEditor,
  storeyExpressId: number,
): boolean {
  // Pull the storey's current attributes (overlay overrides + source).
  const overlay = editor.getNewEntity(storeyExpressId);
  let attrs: unknown[];
  if (overlay) {
    attrs = overlay.attributes.slice();
  } else {
    const ref = dataStore.entityIndex.byId.get(storeyExpressId);
    if (!ref) return false;
    const extractor = new EntityExtractor(dataStore.source);
    const entity = extractor.extractEntity(ref);
    if (!entity) return false;
    attrs = entity.attributes.slice();
  }

  // IfcProduct.ObjectPlacement is at index 5 across IFC2X3 / IFC4.
  // Accept both number refs and `#X` strings as "already present".
  const existing = attrs[5];
  if (typeof existing === 'number' && Number.isFinite(existing)) return false;
  if (typeof existing === 'string' && existing.startsWith('#')) return false;

  // Build a fresh placement at world origin. The storey's elevation
  // (if any) carries through the geometry pipeline elsewhere; this
  // placement gives the IFC graph what resolveSpatialAnchor needs.
  const elevation = dataStore.spatialHierarchy?.storeyElevations?.get(storeyExpressId) ?? 0;
  const originPt = editor.addEntity('IfcCartesianPoint', [[0, 0, elevation]]).expressId;
  const axisPlacement = editor.addEntity('IfcAxis2Placement3D', [`#${originPt}`, null, null]).expressId;
  const localPlacement = editor.addEntity('IfcLocalPlacement', [null, `#${axisPlacement}`]).expressId;

  editor.setPositionalAttribute(storeyExpressId, 5, `#${localPlacement}`);
  return true;
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
  ifcType: string,
  errorContext: string,
  build: (editor: StoreEditor, anchor: ReturnType<typeof resolveSpatialAnchor>) => number,
  meshPayload?: ElementMeshPayload,
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
    const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
    entityId = build(editor, anchor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : `Failed to ${errorContext}` };
  }

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
    const rawName = editor.getNewEntity(entityId)?.attributes?.[2];
    const name = typeof rawName === 'string' ? rawName : '';
    registerAuthoredElement(dataStore.spatialHierarchy, storeyExpressId, entityId, ifcType, name);
  }

  // Build a renderer-frame mesh for the new element so it appears in
  // 3D the moment the action commits — the ImportError-only behaviour
  // before this would only surface the change after an export+reparse.
  let createdMesh: MeshData | null = null;
  if (meshPayload) {
    const storeyElevation =
      dataStore.spatialHierarchy?.storeyElevations?.get(storeyExpressId) ?? 0;
    const globalId = toGlobalIdFromModels(state.models, modelId, entityId);
    const mesh = buildElementMesh({
      type: meshPayload.type,
      globalId,
      storeyElevation,
      payload: meshPayload,
    });
    if (mesh) {
      createdMesh = mesh;
      const cross = get() as unknown as {
        appendGeometryBatch?: (batch: MeshData[]) => void;
      };
      cross.appendGeometryBatch?.([mesh]);
      revealAddedGeometryInModelView(get);
    }
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

  // Mirror the new element to peers (entity + mesh blob). No-op outside collab.
  const newGuid = readNewEntityGuid(editor, entityId);
  get().mirrorEntityCreate(modelId, entityId, ifcType, newGuid, createdMesh);

  return { expressId: entityId };
}

/** Read a freshly-created overlay entity's IFC GlobalId (attribute 0 on IfcRoot). */
function readNewEntityGuid(editor: StoreEditor, expressId: number): string | null {
  const raw = editor.getNewEntity(expressId)?.attributes?.[0];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Build the polygon corner ring used by slab/roof/plate/space mesh
 * previews from a builder param object that may be in rectangle or
 * polygon mode. Rectangle = 4 corners CCW from `Position` +
 * Width/Depth; polygon = the `OuterCurve` lifted to 3D at z = 0.
 */
function profileCornersFromParams(
  params:
    | { Profile?: 'rectangle'; Position: [number, number, number]; Width: number; Depth: number }
    | { Profile: 'polygon'; OuterCurve: Array<[number, number]>; Position?: [number, number, number] },
): Array<[number, number, number]> {
  if ('Profile' in params && params.Profile === 'polygon') {
    const z = params.Position?.[2] ?? 0;
    return params.OuterCurve.map(([x, y]) => [x, y, z]);
  }
  const rect = params as {
    Position: [number, number, number]; Width: number; Depth: number;
  };
  const [px, py, pz] = rect.Position;
  return [
    [px, py, pz],
    [px + rect.Width, py, pz],
    [px + rect.Width, py + rect.Depth, pz],
    [px, py + rect.Depth, pz],
  ];
}

/** Decode the `@N` form used to encode positional indices into Mutation.attributeName. */
function positionalIndex(attributeName: string | undefined): number | null {
  if (!attributeName || attributeName[0] !== '@') return null;
  const n = Number(attributeName.slice(1));
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null;
}

export const createMutationSlice: StateCreator<
  ViewerState,
  [],
  [],
  MutationSlice
> = (set, get) => ({
  // Initial state
  mutationViews: new Map(),
  storeEditors: new Map(),
  removedNewEntities: new Map(),
  changeSets: new Map(),
  activeChangeSetId: null,
  undoStacks: new Map(),
  redoStacks: new Map(),
  mutationBatchTags: new Map(),
  mutationMeshTranslations: new Map(),
  dirtyModels: new Set(),
  mutationVersion: 0,
  georefMutations: new Map(),

  // Georeferencing Mutations
  setGeorefField: (modelId, entity, field, value, oldValue) => {
    get().setGeorefFields(modelId, entity, [{ field, value, oldValue }]);
  },

  setGeorefFields: (modelId, entity, fields) => {
    if (fields.length === 0) return;
    set((state) => {
      const newGeorefMuts = new Map(state.georefMutations);
      const modelMuts = { ...(newGeorefMuts.get(modelId) || {}) };
      const entityMuts = { ...(modelMuts[entity] || {}) } as Record<string, unknown>;
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
      // Drop any stashed undo payloads owned by this model so they don't
      // leak into future mutation views with the same id.
      const newRemoved = new Map(state.removedNewEntities);
      const prefix = `${modelId}:`;
      for (const key of [...newRemoved.keys()]) {
        if (key.startsWith(prefix)) newRemoved.delete(key);
      }
      return {
        mutationViews: newViews,
        storeEditors: newEditors,
        dirtyModels: newDirty,
        removedNewEntities: newRemoved,
      };
    });
  },

  // Property Mutations
  setProperty: (modelId, entityId, psetName, propName, value, valueType = PropertyValueType.String) => {
    // Collab role gate BEFORE the local commit: in a shared session only
    // editor/admin may write. Gating here (not just at the mirror) keeps the
    // local view/undo/dirty state consistent with what actually syncs — a
    // viewer-role user must not build up local-only edits that silently never
    // reach the room. Single-user sessions (role === null) are unaffected.
    if (!get().canCollabEdit()) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.setProperty(entityId, psetName, propName, value, valueType);

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

    // Mirror into the collab CRDT (no-op without a session).
    if (modelId === get().activeModelId) {
      get().mirrorPropertyEdit(entityId, psetName, propName, value, valueType);
    }

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

    // Mirror into the collab CRDT (no-op without a session).
    if (modelId === get().activeModelId) {
      get().mirrorPropertyDelete(entityId, psetName, propName);
    }

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

    // Mirror into the collab CRDT (no-op without a session).
    if (modelId === get().activeModelId) {
      get().mirrorAttributeEdit(entityId, attrName, value);
    }

    return mutation;
  },

  // Entity retype (reassign class)
  setEntityType: (modelId, entityId, newType, predefinedType) => {
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
    // Generate the batch id once; every mutation created below
    // gets tagged with it so the undo / redo handlers can group
    // them. `crypto.randomUUID` is available in every browser the
    // viewer supports and avoids the collision risk of
    // Date.now() + Math.random concatenation.
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const tags = new Map(get().mutationBatchTags);
    for (const { entityId, index, value } of updates) {
      const mutation = get().setPositionalAttribute(modelId, entityId, index, value);
      if (mutation) tags.set(mutation.id, batchId);
    }
    set({ mutationBatchTags: tags });
    return batchId;
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
      if (get().collabTranslateEntity(expressId, delta)) {
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
      const current = get().readCollabPlacement(expressId);
      if (current) {
        const delta: [number, number, number] = [
          position[0] - current.location[0],
          position[1] - current.location[1],
          position[2] - current.location[2],
        ];
        if (get().collabTranslateEntity(expressId, delta)) {
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
        const meshes =
          get().models.get(modelId)?.geometryResult?.meshes ?? get().geometryResult?.meshes ?? null;
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
    if (get().collabRotateEntity(expressId, deltaYaw)) {
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
    const placement = get().readCollabPlacement(expressId);
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
    return get().readCollabPlacement(expressId)?.location ?? null;
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
      const meshes =
        get().models.get(modelId)?.geometryResult?.meshes ?? get().geometryResult?.meshes ?? null;
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

    // Drop the source's mesh from the rendered scene. The entity
    // is tombstoned in the IFC overlay so it won't export; this
    // also clears its GPU buffers and bounding-box entry so picks
    // / bounds stop finding it. The two new walls already have
    // their meshes in the geometry (addWall emits them via
    // appendGeometryBatch).
    const sourceGlobalId = toGlobalIdFromModels(state.models, modelId, expressId);
    state.setPendingMeshRemovals(new Set([sourceGlobalId]));

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

    // Hide source mesh so the user sees the cut take effect; the
    // two new halves already have meshes via addSlab's
    // appendGeometryBatch. The source's mesh is dropped from GPU
    // buffers + bbox map via setPendingMeshRemovals — the
    // streaming hook drains it on the next frame.
    const sourceGlobalId = toGlobalIdFromModels(state.models, modelId, expressId);
    state.setPendingMeshRemovals(new Set([sourceGlobalId]));

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

    // Hide the entity's mesh — the IFC tombstone is what governs
    // exports; the renderer just needs the visual gone. We use
    // hideEntities (visibility set) rather than the harder
    // pendingMeshRemovals path so the undo handler can flip
    // visibility back without needing to re-materialise GPU
    // buffers (the mesh data stays in memory + buckets).
    //
    // The split-source removal path also flows through here; on
    // undo of a split, the source's mesh comes back via
    // `showEntities` in the DELETE_ENTITY undo branch.
    const globalIdForMesh = toGlobalIdFromModels(get().models, modelId, expressId);
    get().hideEntities([globalIdForMesh]);

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

    // Mirror the tombstone to peers (no-op outside a collab session). Callers
    // whose create+delete pair isn't synced yet pass `{ mirror: false }` so
    // only fully-synced deletions propagate.
    if (opts?.mirror !== false) get().mirrorEntityRemove(modelId, expressId);

    return true;
  },

  addColumn: (modelId, storeyExpressId, params) => {
    if (!get().canCollabEdit()) return { error: 'Editing is disabled for your role in this shared session' };
    const state = get();
    const model = state.models.get(modelId);
    const dataStore = model?.ifcDataStore;
    if (!dataStore) return { error: `No model loaded for id "${modelId}"` };

    // The dialog passes the same modelId used by the model store; mutation
    // views are keyed identically (no legacy normalization needed in the
    // multi-model path the dialog operates in).
    const view = state.mutationViews.get(modelId);
    if (!view) return { error: 'Model has no editable mutation view yet' };

    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { error: 'Failed to create store editor' };

    let columnId: number;
    try {
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const result = addColumnToStore(editor, anchor, params);
      columnId = result.columnId;
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to add column' };
    }

    // Inject a renderer-frame box mesh so the column appears in 3D
    // immediately. Same coordinate-frame plumbing as
    // `runInStoreElementBuilder`, kept inline since this action
    // pre-dates the shared helper.
    const storeyElevationCol =
      dataStore.spatialHierarchy?.storeyElevations?.get(storeyExpressId) ?? 0;
    const columnGlobalId = toGlobalIdFromModels(state.models, modelId, columnId);
    const columnMesh = buildElementMesh({
      type: 'column',
      globalId: columnGlobalId,
      storeyElevation: storeyElevationCol,
      payload: {
        type: 'column',
        params: { Width: params.Width, Depth: params.Depth, Height: params.Height },
        position: params.Position,
      },
    });
    if (columnMesh) {
      const cross = get() as unknown as {
        appendGeometryBatch?: (batch: MeshData[]) => void;
      };
      cross.appendGeometryBatch?.([columnMesh]);
      revealAddedGeometryInModelView(get);
    }

    set((s) => {
      const newUndoStacks = new Map(s.undoStacks);
      const stack = newUndoStacks.get(modelId) || [];
      const mutation: Mutation = {
        id: `mut_col_${columnId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        type: 'CREATE_ENTITY',
        timestamp: Date.now(),
        modelId,
        entityId: columnId,
        attributeName: 'IFCCOLUMN',
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

    // Mirror the new column to peers (entity + mesh blob). No-op outside collab.
    get().mirrorEntityCreate(modelId, columnId, 'IFCCOLUMN', readNewEntityGuid(editor, columnId), columnMesh ?? null);

    return { expressId: columnId };
  },

  addWall: (modelId, storeyExpressId, params) => {
    return runInStoreElementBuilder(
      get, set, modelId, storeyExpressId, 'IFCWALL', 'add wall',
      (editor, anchor) => addWallToStore(editor, anchor, params).wallId,
      { type: 'wall', params: { Thickness: params.Thickness, Height: params.Height }, start: params.Start, end: params.End },
    );
  },

  addSlab: (modelId, storeyExpressId, params) => {
    return runInStoreElementBuilder(
      get, set, modelId, storeyExpressId, 'IFCSLAB', 'add slab',
      (editor, anchor) => addSlabToStore(editor, anchor, params).slabId,
      { type: 'slab', params: { Width: 0, Depth: 0, Thickness: params.Thickness }, corners: profileCornersFromParams(params) },
    );
  },

  addBeam: (modelId, storeyExpressId, params) => {
    return runInStoreElementBuilder(
      get, set, modelId, storeyExpressId, 'IFCBEAM', 'add beam',
      (editor, anchor) => addBeamToStore(editor, anchor, params).beamId,
      { type: 'beam', params: { Width: params.Width, Height: params.Height }, start: params.Start, end: params.End },
    );
  },

  addDoor: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, 'IFCDOOR', 'add door',
    (editor, anchor) => addDoorToStore(editor, anchor, params).doorId,
    { type: 'door', params: { Width: params.Width, Height: params.Height, FrameThickness: params.FrameThickness ?? 0.05 }, position: params.Position },
  ),

  addWindow: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, 'IFCWINDOW', 'add window',
    (editor, anchor) => addWindowToStore(editor, anchor, params).windowId,
    { type: 'window', params: { Width: params.Width, Height: params.Height, FrameThickness: params.FrameThickness ?? 0.05 }, position: params.Position },
  ),

  addSpace: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, 'IFCSPACE', 'add space',
    (editor, anchor) => addSpaceToStore(editor, anchor, params).spaceId,
    { type: 'space', params: { Width: 0, Depth: 0, Height: params.Height }, corners: profileCornersFromParams(params) },
  ),

  addRoof: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, 'IFCROOF', 'add roof',
    (editor, anchor) => addRoofToStore(editor, anchor, params).roofId,
    { type: 'roof', params: { Width: 0, Depth: 0, Thickness: params.Thickness }, corners: profileCornersFromParams(params) },
  ),

  addPlate: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, 'IFCPLATE', 'add plate',
    (editor, anchor) => addPlateToStore(editor, anchor, params).plateId,
    { type: 'plate', params: { Width: 0, Depth: 0, Thickness: params.Thickness }, corners: profileCornersFromParams(params) },
  ),

  addMember: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, 'IFCMEMBER', 'add member',
    (editor, anchor) => addMemberToStore(editor, anchor, params).memberId,
    { type: 'member', params: { Width: params.Width, Height: params.Height }, start: params.Start, end: params.End },
  ),

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
    const state = get();
    const model = state.models.get(modelId);
    const dataStore = model?.ifcDataStore;
    if (!dataStore) return { error: `No model loaded for id "${modelId}"` };

    const view = state.mutationViews.get(modelId);
    if (!view) return { error: 'Model has no editable mutation view yet' };

    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { error: 'Failed to create store editor' };

    // Source's bounding box drives the offset magnitude. Multi-model
    // federations key meshes by globalId — route through the central
    // conversion helper so federation/single-model semantics stay in
    // one place (legacy stores fall through to expressId === globalId).
    const sourceGlobalId = toGlobalIdFromModels(state.models, modelId, sourceExpressId);
    const meshes = state.geometryResult?.meshes;
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
      const source = resolveDuplicateSource(dataStore, sourceExpressId);
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
        appendGeometryBatch?: (batch: MeshData[]) => void;
      };
      cross.appendGeometryBatch?.(clonedMeshes);
      revealAddedGeometryInModelView(get);
    }

    return { expressId: newId, globalId: newGlobalId };
  },

  // Undo/Redo
  undo: (modelId) => {
    const state = get();
    const undoStack = state.undoStacks.get(modelId) || [];
    if (undoStack.length === 0) return;

    const mutation = undoStack[undoStack.length - 1];
    // Batch awareness: if the mutation we're about to undo was
    // tagged as part of a batch (via setPositionalAttributesBatch),
    // we want one Ctrl+Z to undo every mutation in that batch.
    // The tail-recurse at the end of this action handles that —
    // capture the batchId here, undo this single mutation, then
    // if the next top still shares the batchId, recurse.
    const batchId = state.mutationBatchTags.get(mutation.id);

    // Handle georef mutations directly on georefMutations map
    if (mutation.type === 'UPDATE_ATTRIBUTE' && mutation.attributeName?.startsWith('georef.')) {
      const parts = mutation.attributeName.split('.');
      const entity = parts[1] as 'projectedCRS' | 'mapConversion';
      const field = parts[2];
      set((s) => {
        const newGeorefMuts = new Map(s.georefMutations);
        const modelMuts = { ...(newGeorefMuts.get(modelId) || {}) };
        const entityMuts = { ...(modelMuts[entity] || {}) } as Record<string, unknown>;
        if (mutation.oldValue !== undefined && mutation.oldValue !== null) {
          entityMuts[field] = mutation.oldValue;
        } else {
          delete entityMuts[field];
        }
        if (Object.keys(entityMuts).length === 0) {
          delete modelMuts[entity];
        } else {
          modelMuts[entity] = entityMuts as typeof modelMuts[typeof entity];
        }
        if (Object.keys(modelMuts).length === 0) {
          newGeorefMuts.delete(modelId);
        } else {
          newGeorefMuts.set(modelId, modelMuts);
        }

        const newUndoStacks = new Map(s.undoStacks);
        newUndoStacks.set(modelId, undoStack.slice(0, -1));
        const newRedoStacks = new Map(s.redoStacks);
        const redoStack = newRedoStacks.get(modelId) || [];
        newRedoStacks.set(modelId, [...redoStack, mutation]);

        return {
          georefMutations: newGeorefMuts,
          undoStacks: newUndoStacks,
          redoStacks: newRedoStacks,
          mutationVersion: s.mutationVersion + 1,
        };
      });
      return;
    }

    const view = state.mutationViews.get(modelId);
    if (!view) return;

    // Apply inverse mutation (skipHistory=true to avoid polluting mutation history)
    if (mutation.type === 'UPDATE_PROPERTY' || mutation.type === 'CREATE_PROPERTY') {
      // Decide by mutation TYPE, not by `oldValue === null`: a property can have
      // a null (unset) value yet still have existed before the edit (an unset
      // Boolean). Undoing a CREATE removes the property; undoing an UPDATE
      // restores its prior value — which may legitimately be null/unset (#1107).
      if (mutation.type === 'CREATE_PROPERTY' && mutation.psetName && mutation.propName) {
        view.deleteProperty(mutation.entityId, mutation.psetName, mutation.propName, true);
      } else if (mutation.psetName && mutation.propName && mutation.oldValue !== undefined) {
        view.setProperty(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          mutation.oldValue,
          mutation.valueType,
          undefined,
          true // skipHistory
        );
      }
    } else if (mutation.type === 'DELETE_PROPERTY') {
      if (mutation.psetName && mutation.propName && mutation.oldValue !== undefined) {
        view.setProperty(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          mutation.oldValue,
          mutation.valueType,
          undefined,
          true // skipHistory
        );
      }
    } else if (mutation.type === 'CREATE_QUANTITY') {
      // Undo creation: remove the quantity mutation
      view.removeQuantityMutation(mutation.entityId, mutation.psetName!, mutation.propName);
    } else if (mutation.type === 'UPDATE_QUANTITY') {
      if (mutation.psetName && mutation.propName && mutation.oldValue !== undefined && mutation.oldValue !== null) {
        view.setQuantity(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          Number(mutation.oldValue),
          undefined,
          undefined,
          true // skipHistory
        );
      }
    } else if (mutation.type === 'UPDATE_ATTRIBUTE') {
      if (mutation.attributeName) {
        if (mutation.oldValue !== undefined && mutation.oldValue !== null) {
          view.setAttribute(mutation.entityId, mutation.attributeName, String(mutation.oldValue), undefined, true);
        } else {
          view.removeAttributeMutation(mutation.entityId, mutation.attributeName);
        }
      }
    } else if (mutation.type === 'UPDATE_POSITIONAL_ATTRIBUTE') {
      // Positional attrs encode their index in `@N` since the existing
      // Mutation shape has no dedicated field for it.
      const index = positionalIndex(mutation.attributeName);
      if (index !== null) {
        if (mutation.oldValue === null || mutation.oldValue === undefined) {
          view.removePositionalMutation(mutation.entityId, index);
        } else {
          view.setPositionalAttribute(mutation.entityId, index, mutation.oldValue as IfcAttributeValue, true);
        }
      }
      // If this mutation carried a mesh translation (gizmo / numeric
      // move), reverse it so the rendered mesh follows the undo.
      const meshMove = get().mutationMeshTranslations.get(mutation.id);
      if (meshMove) {
        get().setPendingMeshTranslations(
          new Map([[meshMove.globalId, [
            -meshMove.rendererDelta[0],
            -meshMove.rendererDelta[1],
            -meshMove.rendererDelta[2],
          ]]]),
        );
      }
    } else if (mutation.type === 'CREATE_ENTITY') {
      // Undo of a create: stash the NewEntity payload so a subsequent redo
      // can restore it. Without this, redo finds an empty stash and becomes
      // a no-op for the create-then-undo-then-redo path.
      const overlay = view.getNewEntity(mutation.entityId);
      if (overlay) {
        set((s) => {
          const next = new Map(s.removedNewEntities);
          next.set(`${modelId}:${mutation.entityId}`, overlay);
          return { removedNewEntities: next };
        });
      }
      // The view's `deleteEntity` returns false if it's already gone, which
      // is fine for redo to re-establish.
      view.deleteEntity(mutation.entityId);
    } else if (mutation.type === 'DELETE_ENTITY') {
      // Undo of a delete: restore tombstone for source entity, OR replay
      // the stashed NewEntity record for an overlay-only entity.
      const stashKey = `${modelId}:${mutation.entityId}`;
      const stashed = get().removedNewEntities.get(stashKey);
      if (stashed) {
        view.restoreNewEntity(stashed);
      } else {
        view.restoreFromTombstone(mutation.entityId);
      }
      // Also un-hide the rendered mesh — the EntityContextMenu's
      // delete handler hid it via the visibility system, so undo has
      // to mirror that to bring the entity back into the scene.
      const cross = get() as unknown as {
        toGlobalId?: (modelId: string, expressId: number) => number;
        showEntity?: (id: number) => void;
      };
      if (cross.toGlobalId && cross.showEntity) {
        const globalId = cross.toGlobalId(modelId, mutation.entityId);
        cross.showEntity(globalId);
      }
    } else if (mutation.type === 'UPDATE_ENTITY_TYPE') {
      // `oldValue` is the class right before this retype: restore it when an
      // earlier retype is still on the stack, otherwise drop the intent to
      // revert the entity to its original class entirely.
      const prevType = mutation.oldValue;
      if (prevType != null && prevType !== '') {
        view.setEntityType(mutation.entityId, String(prevType), undefined, undefined, true);
      } else {
        view.removeTypeMutation(mutation.entityId);
      }
      syncTypeOverride(get, modelId, mutation.entityId);
    }

    set((s) => {
      const newUndoStacks = new Map(s.undoStacks);
      newUndoStacks.set(modelId, undoStack.slice(0, -1));

      const newRedoStacks = new Map(s.redoStacks);
      const redoStack = newRedoStacks.get(modelId) || [];
      newRedoStacks.set(modelId, [...redoStack, mutation]);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        mutationVersion: s.mutationVersion + 1,
      };
    });

    // Tail-recurse for the rest of the batch (if any). Reading
    // the stack via get() picks up the just-set state. Stops as
    // soon as the next top mutation either doesn't exist or
    // belongs to a different batch.
    if (batchId !== undefined) {
      const nextStack = get().undoStacks.get(modelId) || [];
      if (nextStack.length > 0) {
        const nextBatchId = get().mutationBatchTags.get(nextStack[nextStack.length - 1].id);
        if (nextBatchId === batchId) {
          get().undo(modelId);
        }
      }
    }
  },

  redo: (modelId) => {
    const state = get();
    const redoStack = state.redoStacks.get(modelId) || [];
    if (redoStack.length === 0) return;

    const mutation = redoStack[redoStack.length - 1];
    const batchId = state.mutationBatchTags.get(mutation.id);

    // Handle georef mutations directly
    if (mutation.type === 'UPDATE_ATTRIBUTE' && mutation.attributeName?.startsWith('georef.')) {
      const parts = mutation.attributeName.split('.');
      const entity = parts[1] as 'projectedCRS' | 'mapConversion';
      const field = parts[2];
      set((s) => {
        const newGeorefMuts = new Map(s.georefMutations);
        const modelMuts = { ...(newGeorefMuts.get(modelId) || {}) };
        const entityMuts = { ...(modelMuts[entity] || {}) } as Record<string, unknown>;
        if (mutation.newValue !== undefined && mutation.newValue !== null) {
          entityMuts[field] = mutation.newValue;
        } else {
          delete entityMuts[field];
        }
        if (Object.keys(entityMuts).length === 0) {
          delete modelMuts[entity];
        } else {
          modelMuts[entity] = entityMuts as typeof modelMuts[typeof entity];
        }
        if (Object.keys(modelMuts).length === 0) {
          newGeorefMuts.delete(modelId);
        } else {
          newGeorefMuts.set(modelId, modelMuts);
        }

        const newRedoStacks = new Map(s.redoStacks);
        newRedoStacks.set(modelId, redoStack.slice(0, -1));
        const newUndoStacks = new Map(s.undoStacks);
        const undoStack = newUndoStacks.get(modelId) || [];
        newUndoStacks.set(modelId, [...undoStack, mutation]);

        return {
          georefMutations: newGeorefMuts,
          undoStacks: newUndoStacks,
          redoStacks: newRedoStacks,
          mutationVersion: s.mutationVersion + 1,
        };
      });
      return;
    }

    const view = state.mutationViews.get(modelId);
    if (!view) return;

    // Re-apply mutation (skipHistory=true to avoid polluting mutation history)
    if (mutation.type === 'UPDATE_PROPERTY' || mutation.type === 'CREATE_PROPERTY') {
      if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
        view.setProperty(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          mutation.newValue,
          mutation.valueType,
          undefined,
          true // skipHistory
        );
      }
    } else if (mutation.type === 'DELETE_PROPERTY') {
      if (mutation.psetName && mutation.propName) {
        view.deleteProperty(mutation.entityId, mutation.psetName, mutation.propName, true);
      }
    } else if (mutation.type === 'CREATE_QUANTITY' || mutation.type === 'UPDATE_QUANTITY') {
      if (mutation.psetName && mutation.propName && mutation.newValue !== undefined) {
        view.setQuantity(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          Number(mutation.newValue),
          undefined,
          undefined,
          true // skipHistory
        );
      }
    } else if (mutation.type === 'UPDATE_ATTRIBUTE') {
      if (mutation.attributeName && mutation.newValue !== undefined) {
        view.setAttribute(mutation.entityId, mutation.attributeName, String(mutation.newValue), undefined, true);
      }
    } else if (mutation.type === 'UPDATE_POSITIONAL_ATTRIBUTE') {
      const index = positionalIndex(mutation.attributeName);
      if (index !== null && mutation.newValue !== undefined) {
        view.setPositionalAttribute(mutation.entityId, index, mutation.newValue as IfcAttributeValue, true);
      }
      // Replay the mesh translation forward so the rendered mesh
      // follows the redo — mirror of the undo reversal above.
      const meshMove = get().mutationMeshTranslations.get(mutation.id);
      if (meshMove) {
        get().setPendingMeshTranslations(
          new Map([[meshMove.globalId, meshMove.rendererDelta]]),
        );
      }
    } else if (mutation.type === 'CREATE_ENTITY') {
      // Redo of a create: replay from the stashed NewEntity. Symmetrical to
      // DELETE_ENTITY's undo — same map, same key.
      const stashKey = `${modelId}:${mutation.entityId}`;
      const stashed = get().removedNewEntities.get(stashKey);
      if (stashed) {
        view.restoreNewEntity(stashed);
      } else {
        // Source-buffer entities have no stash; the editor's deleteEntity
        // call simply re-tombstoned them — which is exactly what we want
        // here? No — for CREATE_ENTITY redo we want the entity to come back.
        // Source-entity creates are not a real path; CREATE_ENTITY in this
        // codebase only ever fires for overlay-added entities. Nothing to
        // do if the stash is empty (means the redo is unreachable).
      }
    } else if (mutation.type === 'DELETE_ENTITY') {
      // Redo of a delete: tombstone again. For overlay-only entities we
      // first stash the NewEntity (it'll be re-fetched for the next undo).
      const overlay = view.getNewEntity(mutation.entityId);
      if (overlay) {
        set((s) => {
          const next = new Map(s.removedNewEntities);
          next.set(`${modelId}:${mutation.entityId}`, overlay);
          return { removedNewEntities: next };
        });
      }
      view.deleteEntity(mutation.entityId);
      // Re-hide the mesh — symmetric with the menu's delete handler
      // and with the undo path above.
      const cross = get() as unknown as {
        toGlobalId?: (modelId: string, expressId: number) => number;
        hideEntity?: (id: number) => void;
      };
      if (cross.toGlobalId && cross.hideEntity) {
        const globalId = cross.toGlobalId(modelId, mutation.entityId);
        cross.hideEntity(globalId);
      }
    } else if (mutation.type === 'UPDATE_ENTITY_TYPE') {
      const newType = mutation.entityType ?? (typeof mutation.newValue === 'string' ? mutation.newValue : undefined);
      if (newType) {
        view.setEntityType(mutation.entityId, newType, mutation.predefinedType ?? undefined, undefined, true);
      }
      syncTypeOverride(get, modelId, mutation.entityId);
    }

    set((s) => {
      const newRedoStacks = new Map(s.redoStacks);
      newRedoStacks.set(modelId, redoStack.slice(0, -1));

      const newUndoStacks = new Map(s.undoStacks);
      const undoStack = newUndoStacks.get(modelId) || [];
      newUndoStacks.set(modelId, [...undoStack, mutation]);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        mutationVersion: s.mutationVersion + 1,
      };
    });

    // Tail-recurse for the rest of the batch — mirror of the
    // undo handler's batch tail. Stops as soon as the next top
    // of the redo stack either doesn't exist or belongs to a
    // different batch.
    if (batchId !== undefined) {
      const nextStack = get().redoStacks.get(modelId) || [];
      if (nextStack.length > 0) {
        const nextBatchId = get().mutationBatchTags.get(nextStack[nextStack.length - 1].id);
        if (nextBatchId === batchId) {
          get().redo(modelId);
        }
      }
    }
  },

  canUndo: (modelId) => {
    const stack = get().undoStacks.get(modelId);
    return stack ? stack.length > 0 : false;
  },

  canRedo: (modelId) => {
    const stack = get().redoStacks.get(modelId);
    return stack ? stack.length > 0 : false;
  },

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

      const newRemoved = new Map(state.removedNewEntities);
      const prefix = `${modelId}:`;
      for (const key of [...newRemoved.keys()]) {
        if (key.startsWith(prefix)) newRemoved.delete(key);
      }

      const newEditors = new Map(state.storeEditors);
      newEditors.delete(modelId);

      return {
        undoStacks: newUndoStacks,
        redoStacks: newRedoStacks,
        dirtyModels: newDirty,
        georefMutations: newGeorefMuts,
        removedNewEntities: newRemoved,
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
      storeEditors: new Map(),
      mutationVersion: state.mutationVersion + 1,
    }));
  },

  bumpMutationVersion: () => {
    set((state) => ({
      mutationVersion: state.mutationVersion + 1,
    }));
  },
});
