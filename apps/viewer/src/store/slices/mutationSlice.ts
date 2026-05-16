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
import { getEntityBounds } from '@/utils/viewportUtils';
import { toGlobalIdFromModels } from '../globalId.js';
import { buildElementMesh, type ElementMeshPayload } from './addElementMeshes.js';
import type { AddElementType } from './addElementSlice.js';
import {
  resolvePlacementChain,
  resolveRotationState,
  rotateProductYaw,
  resolveWallEditChain,
  resizeRectangleWall,
} from '@/lib/placement-edit.js';

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
    const positions = new Float32Array(m.positions.length);
    for (let i = 0; i < m.positions.length; i += 3) {
      positions[i]     = m.positions[i]     + viewerOffset.x;
      positions[i + 1] = m.positions[i + 1] + viewerOffset.y;
      positions[i + 2] = m.positions[i + 2] + viewerOffset.z;
    }
    out.push({
      expressId: newGlobalId,
      positions,
      normals: m.normals,
      indices: m.indices,
      color: m.color,
      ifcType: m.ifcType,
      modelIndex: m.modelIndex,
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
   * Tombstone an entity (existing source entity) or forget it (overlay-only).
   * Returns true if the entity was known to the store or overlay.
   */
  removeEntity: (modelId: string, expressId: number) => boolean;
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
   */
  translateEntity: (
    modelId: string,
    expressId: number,
    deltaIfc: [number, number, number],
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
   * radians. Updates RefDirection on the placement's IfcAxis2Placement3D.
   * If no explicit RefDirection exists (rare — most builders emit one),
   * a fresh `IfcDirection` is materialised and the axis placement is
   * re-pointed at it.
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
function getOrCreateStoreEditor(
  get: () => ViewerState,
  set: (partial: Partial<ViewerState>) => void,
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
  const next = new Map(state.storeEditors);
  next.set(modelId, editor);
  set({ storeEditors: next });
  return editor;
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
    const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
    entityId = build(editor, anchor);
  } catch (err) {
    return { error: err instanceof Error ? err.message : `Failed to ${errorContext}` };
  }

  // Build a renderer-frame mesh for the new element so it appears in
  // 3D the moment the action commits — the ImportError-only behaviour
  // before this would only surface the change after an export+reparse.
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
      const cross = get() as unknown as {
        appendGeometryBatch?: (batch: MeshData[]) => void;
      };
      cross.appendGeometryBatch?.([mesh]);
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

  return { expressId: entityId };
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

    return mutation;
  },

  deleteProperty: (modelId, entityId, psetName, propName) => {
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

    return mutation;
  },

  createPropertySet: (modelId, entityId, psetName, properties) => {
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

  translateEntity: (modelId, expressId, delta) => {
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
    get().setPositionalAttribute(modelId, chain.cartesianPointId, 0, next);
    return { ok: true, newCoordinates: next };
  },

  setEntityPosition: (modelId, expressId, position) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return { ok: false, reason: 'Model has no editable mutation view yet' };
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { ok: false, reason: 'Failed to resolve store editor' };
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return { ok: false, reason: `No model loaded for id "${modelId}"` };

    const chain = resolvePlacementChain(dataStore, view, editor, expressId);
    if (!chain) {
      return {
        ok: false,
        reason:
          'Entity placement is not a simple IfcLocalPlacement → IfcAxis2Placement3D → IfcCartesianPoint chain',
      };
    }
    get().setPositionalAttribute(modelId, chain.cartesianPointId, 0, position);
    return { ok: true, newCoordinates: position };
  },

  rotateEntity: (modelId, expressId, deltaYaw) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return { ok: false, reason: 'Model has no editable mutation view yet' };
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { ok: false, reason: 'Failed to resolve store editor' };
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return { ok: false, reason: `No model loaded for id "${modelId}"` };

    // resolveRotationState gives us both the current angle and whether
    // RefDirection is materialised. When it's null we delegate to
    // rotateProductYaw which materialises a fresh IfcDirection — that
    // create lives outside the undo stack (acceptable; undo of the
    // axis-placement reference rewrite restores the null pointer and
    // leaves an orphan direction in the overlay). The rewrite itself
    // goes through `setPositionalAttribute` so it IS on the undo stack.
    const state = resolveRotationState(dataStore, view, editor, expressId);
    if (!state) {
      return {
        ok: false,
        reason:
          'Entity placement is not a simple IfcLocalPlacement → IfcAxis2Placement3D chain',
      };
    }
    if (state.refDirectionId === null) {
      // Implicit RefDirection means the axis placement points at no
      // IfcDirection — STEP `$` slot. Materialising a fresh
      // IfcDirection here would require a multi-mutation atomic undo
      // entry to avoid orphans; we don't have that primitive yet.
      // In practice every entity our in-store builders emit
      // (addColumn / addWall / addSlab / …) carries an explicit
      // RefDirection, so this branch only trips on hand-rolled
      // source-buffer entities. Surface a clear refusal so the UI
      // can show "rotate not supported for this entity" rather than
      // silently leaking entities.
      return {
        ok: false,
        reason:
          'Entity has an implicit reference direction (no IfcDirection on its axis placement). Rotation would require materialising a new IfcDirection, which isn\'t undoable yet.',
      };
    }
    const newYaw = state.yawZ + deltaYaw;
    const newRatios: [number, number, number] = [
      Math.cos(newYaw),
      Math.sin(newYaw),
      state.refDirection[2],
    ];
    get().setPositionalAttribute(modelId, state.refDirectionId, 0, newRatios);
    return { ok: true, newYawZ: newYaw };
  },

  readEntityRotation: (modelId, expressId) => {
    // Lazy editor creation — see the note on `readEntityPosition`
    // below. A freshly-loaded model has a mutation view but no
    // cached editor; building one on read so the rotation UI lights
    // up on first selection, not after the first unrelated edit.
    const view = get().mutationViews.get(modelId);
    if (!view) return null;
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return null;
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return null;
    const state = resolveRotationState(dataStore, view, editor, expressId);
    if (!state) return null;
    return { yawZ: state.yawZ, refDirection: state.refDirection };
  },

  readEntityPosition: (modelId, expressId) => {
    // Mirror of `readEntityRotation`'s lazy-create pattern. Used by
    // `GeometryEditCard` to seed its inputs AND by `GizmoOverlay`
    // as its "is this entity movable?" gate — one code path means
    // the controls and the visual gizmo agree on availability.
    const view = get().mutationViews.get(modelId);
    if (!view) return null;
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return null;
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return null;
    const chain = resolvePlacementChain(dataStore, view, editor, expressId);
    return chain ? chain.coordinates : null;
  },

  resizeWall: (modelId, expressId, newStart, newEnd) => {
    const view = get().mutationViews.get(modelId);
    if (!view) return { ok: false, reason: 'Model has no editable mutation view yet' };
    const editor = getOrCreateStoreEditor(get, set, modelId);
    if (!editor) return { ok: false, reason: 'Failed to resolve store editor' };
    const dataStore = get().models.get(modelId)?.ifcDataStore;
    if (!dataStore) return { ok: false, reason: `No model loaded for id "${modelId}"` };

    // resolveWallEditChain reads all four ids without mutating. We
    // then write each via the slice's setPositionalAttribute so the
    // four writes land as four separate mutations on the undo stack
    // — coarse, but matches how the gizmo's translateEntity works.
    // A future pass can introduce a batched-mutation primitive.
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

    get().setPositionalAttribute(modelId, chain.startPointId, 0, newStart);
    get().setPositionalAttribute(modelId, chain.refDirectionId, 0, dir);
    get().setPositionalAttribute(modelId, chain.profileId, 3, length);
    get().setPositionalAttribute(modelId, chain.profileOriginPointId, 0, [length / 2, 0]);

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

  removeEntity: (modelId, expressId) => {
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

    return true;
  },

  addColumn: (modelId, storeyExpressId, params) => {
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
    }

    return { expressId: newId, globalId: newGlobalId };
  },

  // Undo/Redo
  undo: (modelId) => {
    const state = get();
    const undoStack = state.undoStacks.get(modelId) || [];
    if (undoStack.length === 0) return;

    const mutation = undoStack[undoStack.length - 1];

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
      if (mutation.oldValue === null && mutation.psetName && mutation.propName) {
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
  },

  redo: (modelId) => {
    const state = get();
    const redoStack = state.redoStacks.get(modelId) || [];
    if (redoStack.length === 0) return;

    const mutation = redoStack[redoStack.length - 1];

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
