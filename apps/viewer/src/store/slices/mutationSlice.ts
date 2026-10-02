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
import { validatePropertyDataType } from '@ifc-lite/export';
import {
  addDoorToStore,
  addOrdinaryElementInStore,
  addWindowToStore,
  resolveSpatialAnchor,
  generateSpacesFromWalls,
  type BeamInStoreParams,
  type ColumnInStoreParams,
  type DoorInStoreParams,
  type DuplicateInStoreOptions,
  type GenerateSpacesOptions,
  type GenerateSpacesResult,
  type MemberInStoreParams,
  type PlateInStoreParams,
  type ProfiledBeamInStoreParams,
  type ProfiledColumnInStoreParams,
  type ProfiledMemberInStoreParams,
  type RoofInStoreParams,
  type SlabInStoreParams,
  type SpaceInStoreParams,
  type WallInStoreParams,
  type WindowInStoreParams,
} from '@ifc-lite/create';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import { getEntityCenter, unionEntityBounds } from '@/utils/viewportUtils';
import { toGlobalIdFromModels } from '../globalId.js';
import { geometryForOwningModel, meshesForOwningModel } from '../owningModelMeshes.js';
import { modelRotationBaker } from '../../lib/model-placement/rotation-bake.js';
import type { AuthoredElement } from './authoredElement.js';
import { completeAuthoredGeometry, revealAddedGeometryInModelView } from './authoredGeometryCompletion.js';
import { authoredDataStore, syncAuthoredTreeEntry } from './authoredTreeEntry.js';
import { ensureStoreyPlacement } from './storeyPlacement.js';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { copyElements, copySources, withHostedFillings } from '@/lib/commands/modeling/copy-elements';
import { newMutationBatchId } from './mutation-batch-tags.js';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { remeshGridPlacementAfterCommit } from './mutation-grid-remesh';

export type { AuthoredElement };
import { createCostUndoMutations, type CostUndoMethods } from './mutation-cost-undo.js';
import { stashAndPruneEntityMesh, pruneStashByModel, type RemovedMeshStash } from './mutation-mesh-stash.js';
import { applyDuplicatePreAlignmentBaseline } from './mutation-duplicate-prealign.js';
import { pruneMutationHistory } from './mutation-history-prune.js';
import { invalidateHistoryPatch } from './mutation-redo-remote-guard.js';
import {
  resolvePlacementChain,
  resolveRotationState,
  resolveWallEditChain,
  projectOntoWallAxis,
} from '@/lib/placement-edit.js';
import {
  resolveLinearElementChain,
  projectOntoLinearAxis,
  type LinearElementType,
} from '@/lib/linear-element-edit.js';
import { resolveSlabEditChain, type SlabLikeType } from '@/lib/slab-edit.js';
import { getModelLengthUnitScale, pointToMetres, pointToNative } from '@/lib/length-unit-scale.js';
import { readWallMetres, refreshWallMeshIn, resizeWallMetres } from './mutation-wall-resize.js';
import { resolveSplitTarget, splitUnavailableKey } from '@/lib/split-target.js';
import type { TranslationKey } from '@/i18n';
import { splitLinear, splitWall } from './mutation-split.js';
import { splitSlab } from './mutation-split-slab.js';
import type { Point2D } from '@/lib/polygon-clip.js';
import { registerAuthoredElement } from '@/utils/spatialHierarchy.js';
import { withMutationBatchTags } from './mutation-batch-tags.js';
import { canMutate, mutationDenial, mutationDenialKey, mutationPermission } from '../mutation-permission.js';
import { syncTypeOverride } from './mutation-history-apply.js';
import { recordMutationBatch, replayHistory } from './mutation-history-replay.js';
import { dropFromChangeSets, newChangeSet, parseChangeSetFile, recordHistory } from './mutation-history-record.js';
import { positionalMutations } from './mutation-positional-batch.js';
import { addHostedFillIn, type HostedFillOutcome, type HostedFillSpec } from './mutation-hosted-fill.js';

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
   * can correlate; empty input is a no-op (returns null). Pass `batchId`
   * to extend an earlier batch instead of starting one.
   */
  setPositionalAttributesBatch: (
    modelId: string,
    updates: Array<{ entityId: number; index: number; value: IfcAttributeValue }>,
    batchId?: string,
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
  recordAuthoredElement: (modelId: string, storeyExpressId: number, entityId: number, element: AuthoredElement, options?: { historyRecorded?: boolean }) => void;
  /**
   * Book a removal another writer (the SDK `bim.store.removeEntity` adapter)
   * already applied: prune the mesh, stash the overlay record for undo, push
   * the undo entry. Collab mirroring stays with that writer.
   */
  recordEntityRemoval: (modelId: string, expressId: number, overlayRecord: NewEntity | null | undefined) => void;
  /**
   * Translate an IfcProduct by a storey-local delta (IFC Z-up) in METRES,
   * whatever the file's length unit (#6233). Walks
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
   * Read the entity's storey-local placement coordinates in metres. Returns
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
   * points (storey-local metres). Updates the placement origin,
   * RefDirection, profile length, and profile origin as ONE undo step;
   * refuses walls that don't follow the `addWallToStore` shape.
   *
   * `batchId` joins an ongoing step: an endpoint drag passes one id for
   * all its frames (as the move gizmo does with `translateEntity`), and
   * then calls `refreshWallMesh` on release. Without it the local mesh
   * is rebuilt straight away (see `mutation-wall-resize.ts`).
   */
  resizeWall: (
    modelId: string,
    expressId: number,
    newStart: [number, number, number],
    newEnd: [number, number, number],
    batchId?: string,
  ) => { ok: true; newLength: number } | { ok: false; reason: string };
  /** Rebuild a resized wall's mesh locally and for collaborators. */
  refreshWallMesh: (modelId: string, expressId: number) => void;
  /**
   * Whether the Split tool can cut this element, and which commit action
   * does it — the one predicate the Split button and every commit path
   * share (`lib/split-target.ts`, #6233). A refusal carries the catalogue
   * key of its reason for the disabled button's tooltip / error notice.
   */
  readSplitTarget: (
    modelId: string,
    expressId: number,
  ) => { ok: true; kind: 'wall' | 'linear' | 'slab' } | { ok: false; reasonKey: TranslationKey };
  /**
   * Read a wall's current start/end (storey-local metres) so the UI can
   * render endpoint handles. Returns null for non-rectangle walls.
   */
  readWallEndpoints: (
    modelId: string,
    expressId: number,
  ) => { start: [number, number, number]; end: [number, number, number]; thickness: number; height: number } | null;
  /**
   * Split a rectangle-profile wall at `distance` metres along its
   * axis (from the wall's start). Split identity policy
   * (`lib/split-guid.ts`, #6233): the longer piece stays the source
   * wall, shortened in place, keeping its express id, GlobalId, rels
   * and the openings inside it; one new wall with a derived GlobalId
   * takes the other piece, and only the openings inside it move.
   * `left` / `right` are the pieces in axis order; one of them is the
   * source. One Ctrl+Z undoes the whole split
   * (`store/slices/mutation-split.ts`).
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
   * at `distance` metres from start, under the same identity policy
   * as `splitWallAtDistance`: the longer piece is the source with its
   * extrusion shortened (and its start moved to the cut when the far
   * piece is the longer one); one new element takes the other piece.
   */
  splitLinearElementAtDistance: (
    modelId: string,
    expressId: number,
    distanceFromStart: number,
  ) => { ok: true; left: { expressId: number; globalId: number }; right: { expressId: number; globalId: number } } | { ok: false; reason: string };
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
   * points. The larger-area piece stays the source, its profile
   * rewritten to the clipped polygon (`IfcArbitraryClosedProfileDef`);
   * one new element with a derived GlobalId takes the other piece
   * (`store/slices/mutation-split-slab.ts`, #6233).
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
    params: ColumnInStoreParams | ProfiledColumnInStoreParams
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
  /** Add an IfcBeam anchored to a storey: a rectangle (`Width` x `Height`) or a parametric `Profile`. */
  addBeam: (
    modelId: string,
    storeyExpressId: number,
    params: BeamInStoreParams | ProfiledBeamInStoreParams
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
  /**
   * Cut an opening into a host wall (or slab), or place a door or window in
   * one: the whole graph as one undo batch, the host re-meshed with its void
   * (`mutation-hosted-fill.ts`). The one write path of the placing commands
   * and of `bim.store.addOpening` / `addHostedDoor` / `addHostedWindow`.
   * `batchId`: the running modeling transaction, which then re-meshes.
   */
  addHostedFill: (
    modelId: string,
    hostExpressId: number,
    spec: HostedFillSpec,
    batchId?: string,
  ) => HostedFillOutcome;
  /** Add an IfcSpace (room) — rectangle or polygon footprint. */
  addSpace: (
    modelId: string,
    storeyExpressId: number,
    params: SpaceInStoreParams,
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
    params: MemberInStoreParams | ProfiledMemberInStoreParams
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
   * Uses the same complete copy write as Paste and Array: assembly parts,
   * hosted openings and fillings travel with their host. Source meshes are
   * mirrored immediately and rebuilt through wasm. The complete copied
   * graph is one undo step; disconnected parent frames are refused.
   * Returns the new entity's express id, or an error message.
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
  /** Set the change set new edits land in (null: the next edit starts "Unsaved changes"). */
  setActiveChangeSet: (id: string | null) => void;
  /** Export change set as JSON */
  exportChangeSet: (id: string) => string | null;
  /** Rename a change set. */
  renameChangeSet: (id: string, name: string) => void;
  /** Drop a change set (the edits stay in the model); clears it as the active set. */
  deleteChangeSet: (id: string) => void;
  /** Add a change set from an exported file. Returns its id, or null when the text is not a change set. */
  importChangeSet: (json: string) => string | null;

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
  // this during render via GeometryEditCard's `readSplitTarget` memo, and a
  // reactive `set()` there triggers React's "cannot update a component
  // while rendering a different component" warning. In-place caching
  // keeps the editor memoised without scheduling a render-phase update.
  state.storeEditors.set(modelId, editor);
  return editor;
}

/** `start + axis · t`. */
function alongAxis(start: readonly number[], axis: readonly number[], t: number): [number, number, number] {
  return [start[0] + axis[0] * t, start[1] + axis[1] * t, start[2] + axis[2] * t];
}

/**
 * The (view, editor, dataStore, metre scale) every read-only chain reader
 * needs, created lazily so handles surface on first selection. Null while
 * the model has no editable view.
 */
function resolveEditReadContext(
  get: () => ViewerState,
  set: (partial: Partial<ViewerState>) => void,
  modelId: string,
) {
  const view = get().mutationViews.get(modelId);
  const editor = view ? getOrCreateStoreEditor(get, set, modelId) : null;
  const dataStore = get().models.get(modelId)?.ifcDataStore;
  if (!view || !editor || !dataStore) return null;
  return { view, editor, dataStore, scale: getModelLengthUnitScale(dataStore) };
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
): { expressId: number } | { error: string } {
  const denial = mutationDenial(get(), modelId);
  if (denial) return { error: denial };
  const state = get();
  const model = state.models.get(modelId);
  const dataStore = model?.ifcDataStore;
  if (!dataStore) return { error: `No model loaded for id "${modelId}"` };

  const view = state.mutationViews.get(modelId);
  if (!view) return { error: 'Model has no editable mutation view yet' };

  const editor = getOrCreateStoreEditor(get, set, modelId);
  if (!editor) return { error: 'Failed to create store editor' };

  let entityId: number;
  try {
    const prepareAnchor = (draft: StoreEditor) => {
      // Preserve the UI's existing optional-placement policy, but include its
      // helper writes in the same transaction as the builder (#6232 D5).
      ensureStoreyPlacement(dataStore, draft, storeyExpressId);
      return resolveSpatialAnchor(dataStore, storeyExpressId, draft.getMutationView());
    };
    entityId = element.kind === 'door'
      ? editor.runAtomic(draft => addDoorToStore(draft, prepareAnchor(draft), element.params).doorId)
      : element.kind === 'window'
        ? editor.runAtomic(draft => addWindowToStore(draft, prepareAnchor(draft), element.params).windowId)
        : addOrdinaryElementInStore(editor, prepareAnchor, element);
  } catch (err) {
    return { error: err instanceof Error ? err.message : `Failed to add ${element.kind}` };
  }

  // Mirror the new entity to peers first; its mesh follows from the re-mesh
  // `recordAuthoredElementIn` asks for. No-op outside collab.
  get().mirrorEntityCreate(modelId, entityId, authoredIfcType(element), readNewEntityGuid(editor, entityId), null);
  recordAuthoredElementIn(get, set, modelId, dataStore, view, storeyExpressId, entityId, element);

  return { expressId: entityId };
}

const authoredIfcType = (element: AuthoredElement): string => `IFC${element.kind.toUpperCase()}`;

/**
 * Everything after an in-store builder ran, shared by the UI actions and by
 * the SDK `bim.store.add*` adapter. The adapter used to stop at the builder,
 * so a script's or flow's elements existed only in the export overlay: no
 * mesh, no tree entry, no undo, and no `mutationVersion` bump to tell anything
 * they were there. The mesh comes from the wasm re-mesh of the written IFC
 * (#6232), in the model's own frame and mirrored to the room when it lands,
 * or from the element's parameters where the re-mesh declines.
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
  options: { historyRecorded?: boolean } = {},
): void {
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

  const mutation: Mutation = {
    id: `mut_${ifcType.toLowerCase()}_${entityId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    type: 'CREATE_ENTITY',
    timestamp: Date.now(),
    modelId,
    entityId,
    attributeName: ifcType,
  };
  if (!options.historyRecorded) set((s) => recordHistory(s, modelId, [mutation]));

  // Real geometry for the new element, from the IFC it was written as; drawn
  // from its parameters where the re-mesh can't mesh it (authoredFallbackMesh.ts).
  completeAuthoredGeometry(get, modelId, dataStore, storeyExpressId, entityId, element);
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

    const mutation: Mutation = {
      id: `mut_del_${expressId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: 'DELETE_ENTITY',
      timestamp: Date.now(),
      modelId,
      entityId: expressId,
    };
    return { removedNewEntities: newRemoved, ...recordHistory(state, modelId, [mutation]) };
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
    if (!canMutate(get(), modelId)) return;
    set((state) => {
      const newGeorefMuts = new Map(state.georefMutations);
      const modelMuts = { ...newGeorefMuts.get(modelId) };
      const entityMuts = { ...modelMuts[entity] } as Record<string, unknown>;
      for (const entry of fields) {
        entityMuts[entry.field] = entry.value;
      }
      newGeorefMuts.set(modelId, { ...modelMuts, [entity]: entityMuts });

      // Track undo
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
      return { georefMutations: newGeorefMuts, ...recordHistory(state, modelId, nextMutations) };
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
        ...dropFromChangeSets(state, state.undoStacks.get(modelId) ?? []),
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
    // Apply the shared edit-mode, role, and model gate before touching the
    // overlay, undo/redo, dirty state, or collaboration mirror (#5901).
    if (!canMutate(get(), modelId)) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    if (dataType !== undefined) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error('Explicit property declarations require a scalar value');
      const declaration = validatePropertyDataType(value, dataType);
      dataType = declaration.dataType;
      valueType = declaration.valueType;
    }
    const mutation = view.setProperty(entityId, psetName, propName, value, valueType, undefined, false, dataType);

    set((state) => recordHistory(state, modelId, [mutation]));

    // Mirror into the collab CRDT (no-op without a session, and no-op unless
    // `modelId` is the ROOM's model — the mirror gates itself on the modelId it
    // is handed, so this call site cannot get the subject wrong. See
    // `@/lib/collab/room-model-target`.)
    get().mirrorPropertyEdit(modelId, entityId, psetName, propName, value, valueType, dataType);

    return mutation;
  },

  deleteProperty: (modelId, entityId, psetName, propName) => {
    // Shared mutation gate before the local commit — see setProperty.
    if (!canMutate(get(), modelId)) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.deleteProperty(entityId, psetName, propName);
    if (!mutation) return null;

    set((state) => recordHistory(state, modelId, [mutation]));

    // Mirror into the collab CRDT — room model only, gated in the callee. See
    // the note in `setProperty`.
    get().mirrorPropertyDelete(modelId, entityId, psetName, propName);

    return mutation;
  },

  createPropertySet: (modelId, entityId, psetName, properties) => {
    // Shared mutation gate before the local commit — see setProperty. (Pset
    // creation isn't mirrored yet, which is all the more reason a read-only
    // role must not accumulate local-only psets in a shared session.)
    if (!canMutate(get(), modelId)) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.createPropertySet(entityId, psetName, properties);

    set((state) => recordHistory(state, modelId, [mutation]));

    return mutation;
  },

  deletePropertySet: (modelId, entityId, psetName) => {
    // Shared mutation gate before the local commit — see setProperty. Removing a
    // pset is no less of a write than creating one, and this arm was the one
    // `createPropertySet` and `deleteProperty` were both given the gate and
    // this one was not.
    if (!canMutate(get(), modelId)) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.deletePropertySet(entityId, psetName);

    set((state) => recordHistory(state, modelId, [mutation]));

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
    if (!canMutate(get(), modelId)) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.setQuantity(entityId, qsetName, quantName, value, quantityType, unit);

    set((state) => recordHistory(state, modelId, [mutation]));

    return mutation;
  },

  createQuantitySet: (modelId, entityId, qsetName, quantities) => {
    // See setQuantity above — same omission, same reason.
    if (!canMutate(get(), modelId)) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.createQuantitySet(entityId, qsetName, quantities);

    set((state) => recordHistory(state, modelId, [mutation]));

    return mutation;
  },

  // Attribute Mutations
  setAttribute: (modelId, entityId, attrName, value, oldValue) => {
    // Shared mutation gate before the local commit — see setProperty.
    if (!canMutate(get(), modelId)) return null;
    const view = get().mutationViews.get(modelId);
    if (!view) return null;

    const mutation = view.setAttribute(entityId, attrName, value, oldValue);

    set((state) => recordHistory(state, modelId, [mutation]));

    // Mirror into the collab CRDT — room model only, gated in the callee. See
    // the note in `setProperty`.
    get().mirrorAttributeEdit(modelId, entityId, attrName, value);

    return mutation;
  },

  // Entity retype (reassign class)
  setEntityType: (modelId, entityId, newType, predefinedType) => {
    // Shared mutation gate before the local commit — see setProperty. Reclassing an
    // entity is an attribute write like any other, and `setAttribute` is gated.
    if (!canMutate(get(), modelId)) return null;
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

    set((state) => recordHistory(state, modelId, [mutation!]));

    return mutation;
  },

  // Store-Level Mutations
  setPositionalAttribute: (modelId, entityId, index, value) => {
    // Shared mutation gate before the local commit — see setProperty. This is the
    // rawest write in the slice (a direct STEP slot overwrite); every named
    // mutation above it is gated, so leaving this one open gated nothing.
    if (!canMutate(get(), modelId)) return null;
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
    set((state) => recordHistory(state, modelId, [mutation]));
    return mutation;
  },

  setPositionalAttributesBatch: (modelId, updates, continuing) => {
    // Same gate as setPositionalAttribute; one store update for the whole batch.
    if (updates.length === 0 || !canMutate(get(), modelId) || !get().mutationViews.get(modelId)) return null;
    const editor = getOrCreateStoreEditor(get, set, modelId);
    return editor ? recordMutationBatch(set, modelId, positionalMutations(editor, modelId, updates), continuing) : null;
  },

  recordMutationBatch: (modelId, mutations, batchId) => recordMutationBatch(set, modelId, mutations, batchId),

  tagMutationBatch: (mutationIds, batchId) => {
    if (mutationIds.length === 0) return;
    set((s) => ({ mutationBatchTags: withMutationBatchTags(s.mutationBatchTags, mutationIds, batchId) }));
  },

  translateEntity: (modelId, expressId, delta, batchId) => {
    // Shared mutation gate also protects geometry writes.
    const denial = mutationDenial(get(), modelId);
    if (denial) return { ok: false, reason: denial };
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
    // `delta` is metres; the point holds the file's native unit (#6233).
    const [x, y, z] = chain.coordinates;
    const [nx, ny, nz] = pointToNative(dataStore, delta);
    const nativeNext: [number, number, number] = [x + nx, y + ny, z + nz];
    // Go through the slice's own `setPositionalAttribute` action so
    // the mutation lands on the undo stack with the standard envelope.
    const mutation = get().setPositionalAttribute(modelId, chain.cartesianPointId, 0, nativeNext);

    if (!remeshGridPlacementAfterCommit(get, modelId, expressId, mutation, batchId)) {

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

    }
    // Mirror the move to peers as the entity's canonical placement
    // (`usd::xformop`). No-op outside a collab session.
    get().mirrorPlacementEdit(modelId, expressId, delta);

    return { ok: true, newCoordinates: pointToMetres(dataStore, nativeNext) };
  },

  setEntityPosition: (modelId, expressId, position) => {
    const denial = mutationDenial(get(), modelId);
    if (denial) return { ok: false, reason: denial };
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
    // Z-up → Y-up conversion as `translateEntity` above. `position` is
    // metres; the point holds the file's native unit (#6233).
    const [oldX, oldY, oldZ] = pointToMetres(dataStore, chain.coordinates);
    const dx = position[0] - oldX;
    const dy = position[1] - oldY;
    const dz = position[2] - oldZ;
    const mutation = get().setPositionalAttribute(modelId, chain.cartesianPointId, 0, pointToNative(dataStore, position));
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      if (!remeshGridPlacementAfterCommit(get, modelId, expressId, mutation)) {
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
      }
      // Mirror the move to peers as the entity's placement (`usd::xformop`).
      get().mirrorPlacementEdit(modelId, expressId, [dx, dy, dz]);
    }
    return { ok: true, newCoordinates: position };
  },

  rotateEntity: (modelId, expressId, deltaYaw) => {
    const denial = mutationDenial(get(), modelId);
    if (denial) return { ok: false, reason: denial };
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
        const mutation = get().setPositionalAttribute(modelId, state.refDirectionId, 0, newRatios);
        if (!remeshGridPlacementAfterCommit(get, modelId, expressId, mutation)) {
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
        if (chain) return pointToMetres(dataStore, chain.coordinates);
      }
    }
    // No STEP chain (recipient's IFCX-reconstructed store): fall back to the
    // collab placement so the move gizmo + geometry card still surface. The
    // gizmo's origin comes from the mesh bbox, so a [0,0,0] here is fine — this
    // is purely the "is this entity movable?" gate.
    return get().readCollabPlacement(modelId, expressId)?.location ?? null;
  },

  resizeWall: (modelId, expressId, newStart, newEnd, batchId) => {
    const denial = mutationDenial(get(), modelId);
    if (denial) return { ok: false, reason: denial };
    const view = get().mutationViews.get(modelId);
    if (!view) return { ok: false, reason: 'Model has no editable mutation view yet' };
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { ok: false, reason: 'Failed to resolve store editor' };
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return { ok: false, reason: `No model loaded for id "${modelId}"` };
    const result = resizeWallMetres(api, { dataStore, view, editor }, modelId, expressId, newStart, newEnd, batchId);
    // A drag rebuilds the mesh once, on release; a one-off resize right away.
    if (result.ok && batchId === undefined) get().refreshWallMesh(modelId, expressId);
    return result;
  },

  refreshWallMesh: (modelId, expressId) => refreshWallMeshIn(get, modelId, expressId),

  readSplitTarget: (modelId, expressId) => {
    const permission = mutationPermission(get(), modelId);
    if (!permission.allowed) return { ok: false, reasonKey: mutationDenialKey(permission.reason) };
    const ctx = resolveEditReadContext(get, set, modelId);
    if (!ctx) return { ok: false, reasonKey: mutationDenialKey('model-unavailable') };
    const target = resolveSplitTarget(ctx.dataStore, ctx.view, ctx.editor, expressId, ctx.scale);
    return target.ok ? { ok: true, kind: target.kind } : { ok: false, reasonKey: splitUnavailableKey(target.code) };
  },

  readWallEndpoints: (modelId, expressId) => {
    // Same lazy-create pattern as `readEntityRotation` /
    // `readEntityPosition` — handles need to surface on first
    // selection, not after an unrelated mutation has primed the
    // editor cache.
    const view = get().mutationViews.get(modelId);
    const editor = view ? getOrCreateStoreEditor(get, set, modelId) : null;
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    const wall = view && editor && dataStore ? readWallMetres({ dataStore, view, editor }, expressId) : null;
    return wall ? { start: wall.start, end: wall.end, thickness: wall.thickness, height: wall.height } : null;
  },

  readWallSplitProjection: (modelId, expressId, cursorStoreyLocal) => {
    const ctx = resolveEditReadContext(get, set, modelId);
    const chain = ctx && resolveWallEditChain(ctx.dataStore, ctx.view, ctx.editor, expressId, ctx.scale);
    if (!chain) return null;
    const distance = projectOntoWallAxis(chain, cursorStoreyLocal);
    // Walls lie on a storey plane (refDirection.z === 0 by the builder's
    // contract), but whatever the IFC says is surfaced as-is.
    const [dx, dy, dz] = chain.refDirection;
    const cutPoint = alongAxis(chain.startCoordinates, chain.refDirection, distance);
    return { distance, length: chain.wallLength, cutPoint, axis: [dx, dy, dz] };
  },

  splitWallAtDistance: (modelId, expressId, distanceFromStart) =>
    splitWall(get, (id) => getOrCreateStoreEditor(get, set, id), modelId, expressId, distanceFromStart, api),

  readLinearElementSplitProjection: (modelId, expressId, cursorStoreyLocal) => {
    const ctx = resolveEditReadContext(get, set, modelId);
    const chain = ctx && resolveLinearElementChain(ctx.dataStore, ctx.view, ctx.editor, expressId, ctx.scale);
    if (!chain) return null;
    const distance = projectOntoLinearAxis(chain, cursorStoreyLocal);
    const cutPoint = alongAxis(chain.startCoordinates, chain.axisDirection, distance);
    return { distance, length: chain.depth, cutPoint, axis: chain.axisDirection, elementType: chain.elementType };
  },

  splitLinearElementAtDistance: (modelId, expressId, distanceFromStart) =>
    splitLinear(get, (id) => getOrCreateStoreEditor(get, set, id), modelId, expressId, distanceFromStart),

  readSlabFootprint: (modelId, expressId) => {
    const ctx = resolveEditReadContext(get, set, modelId);
    const chain = ctx && resolveSlabEditChain(ctx.dataStore, ctx.view, ctx.editor, expressId, ctx.scale);
    if (!ctx || !chain) return null;
    const { dataStore, view } = ctx;
    const storeyId = effectiveStoreyId(dataStore, view, expressId);
    const storeyElevation = (storeyId !== undefined ? dataStore.spatialHierarchy?.storeyElevations?.get(storeyId) : undefined) ?? 0;
    return { footprint: chain.footprint, elementType: chain.elementType, storeyElevation, thickness: chain.thickness };
  },

  splitSlabByLine: (modelId, expressId, cutA, cutB) =>
    splitSlab(get, (id) => getOrCreateStoreEditor(get, set, id), modelId, expressId, cutA, cutB, api),

  removeEntity: (modelId, expressId, opts) => {
    if (!canMutate(get(), modelId)) return false;
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
  ),

  addWall: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'wall', params },
  ),

  addSlab: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'slab', params },
  ),

  addBeam: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'beam', params },
  ),

  addDoor: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'door', params },
  ),

  addWindow: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'window', params },
  ),

  addHostedFill: (modelId, hostExpressId, spec, batchId) => addHostedFillIn(api, modelId, hostExpressId, spec, { batchId }),

  addSpace: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'space', params },
  ),

  addRoof: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'roof', params },
  ),

  addPlate: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'plate', params },
  ),

  addMember: (modelId, storeyExpressId, params) => runInStoreElementBuilder(
    get, set, modelId, storeyExpressId, { kind: 'member', params },
  ),

  recordAuthoredElement: (modelId, storeyExpressId, entityId, element, options) => {
    const dataStore = authoredDataStore(get(), modelId);
    const view = get().mutationViews.get(modelId);
    if (!dataStore || !view) return;
    recordAuthoredElementIn(get, set, modelId, dataStore, view, storeyExpressId, entityId, element, options);
  },

  generateSpacesFromWalls: (modelId, storeyExpressId, options) => {
    if (!options?.dryRun) {
      const denial = mutationDenial(get(), modelId);
      if (denial) return { error: denial };
    }
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

    const ts = Date.now();
    const spaces: Mutation[] = result.emitted.map((e) => ({
      id: `mut_ifcspace_${e.result.spaceId}_${ts}_${Math.random().toString(36).substring(2, 9)}`,
      type: 'CREATE_ENTITY',
      timestamp: ts,
      modelId,
      entityId: e.result.spaceId,
      attributeName: 'IFCSPACE',
    }));
    set((s) => recordHistory(s, modelId, spaces));

    return result;
  },

  duplicateEntity: (modelId, sourceExpressId, direction = DUPLICATE_DEFAULT_DIRECTION, options) => {
    // Gate before the local commit, as addElementViaBuilder does for creates.
    const denial = mutationDenial(get(), modelId);
    if (denial) return { error: denial };
    const state = get();
    const model = state.models.get(modelId);
    const dataStore = model?.ifcDataStore;
    if (!dataStore) return { error: `No model loaded for id "${modelId}"` };

    const view = state.mutationViews.get(modelId);
    if (!view) return { error: 'Model has no editable mutation view yet' };

    const sources = copySources(state, modelId, [sourceExpressId]);
    if ('refusal' in sources) return { error: sources.refusal };

    // Source's bounding box drives the offset magnitude; meshes are keyed by globalId, so they must
    // come from the EDITED model, not the active model's top-level mirror (#4929).
    // Read in the MODEL frame, not the live baked bytes: the rotation bake turns the appended copy once (#4873).
    const shown = withHostedFillings(state, modelId, [sourceExpressId]);
    const shownGlobalIds = shown.map((id) => toGlobalIdFromModels(state.models, modelId, id));
    const shownSet = new Set(shownGlobalIds);
    const owningGeometry = geometryForOwningModel(state, modelId);
    const owningMeshes = owningGeometry?.meshes.filter((m) => shownSet.has(m.expressId)).map((m) => modelRotationBaker.inModelFrame(m));
    const sourceBounds = unionEntityBounds(owningMeshes ?? null, shownGlobalIds, (id) => {
      const box = owningGeometry && modelRotationBaker.instancedBoundsInModelFrame(owningGeometry, id);
      if (!box || ![...box.min, ...box.max].every(Number.isFinite)) return null;
      return { min: { x: box.min[0], y: box.min[1], z: box.min[2] }, max: { x: box.max[0], y: box.max[1], z: box.max[2] } };
    });
    const bbox: ViewerBox = sourceBounds
      ? { size: {
          x: Math.max(sourceBounds.max.x - sourceBounds.min.x, 0),
          y: Math.max(sourceBounds.max.y - sourceBounds.min.y, 0),
          z: Math.max(sourceBounds.max.z - sourceBounds.min.z, 0),
        } }
      : { size: { x: DUPLICATE_FALLBACK_STEP, y: DUPLICATE_FALLBACK_STEP, z: DUPLICATE_FALLBACK_STEP } };

    const ifcDelta = ifcOffsetForDirection(direction, bbox);
    const viewerDelta = viewerDeltaFromIfc(ifcDelta);

    const batchId = newMutationBatchId();
    let copied: ReturnType<typeof copyElements>;
    try {
      copied = copyElements(api, modelId, [sourceExpressId], [{ offset: ifcDelta }], { batchId, duplicate: options ?? {} });
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to duplicate' };
    }
    const newId = copied.copies[0];
    const newGlobalId = toGlobalIdFromModels(state.models, modelId, newId);

    revealAddedGeometryInModelView(get);

    // Immediate translated source geometry; the canonical wasm re-mesh below
    // replaces it from the copied IFC, including all parts and hosted fillings.
    for (const id of copied.meshed) {
      const source = copied.copiedFrom.get(id);
      if (source === undefined) continue;
      const sourceGlobalId = toGlobalIdFromModels(state.models, modelId, source);
      const clonedMeshes = cloneMeshesWithOffset(owningMeshes, sourceGlobalId, toGlobalIdFromModels(state.models, modelId, id), viewerDelta);
      if (clonedMeshes.length === 0) continue;
      get().appendGeometryBatch(modelId, clonedMeshes);
      applyDuplicatePreAlignmentBaseline(set, modelId, sourceGlobalId, clonedMeshes.length, viewerDelta);
    }
    remeshAfterCommit(get, modelId, batchId, copied.meshed, 'created');

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

  invalidateHistoryForEntity: (modelId, entityId) => set((s) => {
    const patch = invalidateHistoryPatch(s.undoStacks, s.redoStacks, s.mutationBatchTags, s.mutationMeshTranslations, modelId, entityId);
    // Whatever the patch removed from this model's undo stack also leaves its change sets.
    if (!patch.undoStacks) return patch;
    const kept = new Set((patch.undoStacks.get(modelId) ?? []).map((m) => m.id));
    return { ...patch, ...dropFromChangeSets(s, (s.undoStacks.get(modelId) ?? []).filter((m) => !kept.has(m.id))) };
  }),
  // Change Sets (#6232 D4). Edits are filed by `recordHistory`.
  createChangeSet: (name) => {
    const changeSet = newChangeSet(name);
    set((state) => ({ changeSets: new Map(state.changeSets).set(changeSet.id, changeSet), activeChangeSetId: changeSet.id }));
    return changeSet.id;
  },

  getActiveChangeSet: () => {
    const state = get();
    if (!state.activeChangeSetId) return null;
    return state.changeSets.get(state.activeChangeSetId) || null;
  },

  setActiveChangeSet: (id) => {
    if (id !== null && !get().changeSets.has(id)) return;
    set({ activeChangeSetId: id });
  },

  renameChangeSet: (id, name) => set((state) => {
    const changeSet = state.changeSets.get(id);
    return changeSet ? { changeSets: new Map(state.changeSets).set(id, { ...changeSet, name }) } : {};
  }),

  deleteChangeSet: (id) => set((state) => {
    if (!state.changeSets.has(id)) return {};
    const changeSets = new Map(state.changeSets);
    changeSets.delete(id);
    return { changeSets, activeChangeSetId: state.activeChangeSetId === id ? null : state.activeChangeSetId };
  }),

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
    const changeSet = parseChangeSetFile(json);
    if (!changeSet) return null;
    set((state) => ({ changeSets: new Map(state.changeSets).set(changeSet.id, changeSet) }));
    return changeSet.id;
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
        ...dropFromChangeSets(state, state.undoStacks.get(modelId) ?? []),
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
      ...dropFromChangeSets(state, [...state.undoStacks.values()].flat()),
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
