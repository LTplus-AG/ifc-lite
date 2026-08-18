/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared types for the viewer store
 */

// ============================================================================
// Measurement Types
// ============================================================================

export interface MeasurePoint {
  x: number;
  y: number;
  z: number;
  screenX: number;
  screenY: number;
}

export interface Measurement {
  id: string;
  start: MeasurePoint;
  end: MeasurePoint;
  distance: number;
}

/** Active measurement for drag-based interaction */
export interface ActiveMeasurement {
  start: MeasurePoint;
  current: MeasurePoint;
  distance: number;
}

// ============================================================================
// Polyline Measurement Types (multi-click accumulate mode, issue #2199)
// ============================================================================

/**
 * Which gesture the Measure tool is currently listening for. `'drag'` is the
 * original mousedown→mouseup distance measurement (unchanged by this mode).
 * `'polyline'` accumulates points via successive clicks instead; `'angle'`
 * (#2735) accumulates a FIXED number of clicks and finishes itself. All three
 * are mutually exclusive so a sequence started in one can never leak state
 * into another (see `setMeasureMode` in measurementSlice.ts).
 */
export type MeasureMode = 'drag' | 'polyline' | 'angle';

/** A multi-click sequence in progress, not yet finished or cancelled. */
export interface ActivePolyline {
  points: MeasurePoint[];
}

/**
 * A finished multi-click measurement. `closed` is the basis for `length` and
 * must always be read alongside it (never assumed): for an open polyline,
 * `length` is the sum of the placed segments; for a closed loop it is the
 * perimeter, i.e. the same sum PLUS the closing segment back to the first
 * point. The tool never blends the two under one unlabelled number.
 */
export interface PolylineMeasurement {
  id: string;
  points: MeasurePoint[];
  closed: boolean;
  length: number;
}

// ============================================================================
// Angle Measurement Types (issue #2735, split from #2199 §4)
// ============================================================================

/**
 * Which angle the tool is measuring. Only `'points'` ships today; the edge and
 * face kinds are the later slices of #2735 and are named here so the store
 * shape does not have to change when they land.
 */
export type AngleKind = 'points' | 'edges' | 'faces';

/** How many picks each kind needs before the measurement finishes itself. */
export const ANGLE_REQUIRED_PICKS: Record<AngleKind, number> = {
  points: 3,
  edges: 2,
  faces: 2,
};

/** One pick in an angle sequence. */
export interface AnglePick {
  kind: AngleKind;
  point: MeasurePoint;
}

/** A fixed-length sequence in progress, not yet complete or cancelled. */
export interface ActiveAngle {
  kind: AngleKind;
  picks: AnglePick[];
}

/**
 * A finished angle measurement.
 *
 * Only the PICKS are stored, never the resulting degrees - the readout is
 * derived on render by `threePointAngle`. That follows `inclination.ts` rather
 * than `PolylineMeasurement` (which does store its `length`): an angle's value
 * is pure maths over its picks, so deriving it means a correction to the maths
 * retroactively fixes every measurement already on screen, and there is no
 * second copy of the answer to fall out of step with the picks.
 */
export interface AngleMeasurement {
  id: string;
  kind: AngleKind;
  picks: AnglePick[];
}

/** Orthogonal constraint axis type */
export type OrthogonalAxis = 'axis1' | 'axis2' | 'axis3';

/** Vec3 type for constraint calculations */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Orthogonal constraint for measurements (shift+drag) */
export interface MeasurementConstraintEdge {
  /** Three orthogonal axes for constraint snapping */
  axes: {
    axis1: Vec3;
    axis2: Vec3;
    axis3: Vec3;
  };
  /** Axis colors for visualization */
  colors: {
    axis1: string;
    axis2: string;
    axis3: string;
  };
  /** Currently active constraint axis (computed from cursor direction) */
  activeAxis: OrthogonalAxis | null;
}

// ============================================================================
// Edge Lock Types (Magnetic Snapping)
// ============================================================================

export interface EdgeLockState {
  /** The locked edge vertices (in world space) */
  edge: { v0: { x: number; y: number; z: number }; v1: { x: number; y: number; z: number } } | null;
  /** Which mesh the edge belongs to */
  meshExpressId: number | null;
  /** Current position along the edge (0-1, where 0 = v0, 1 = v1) */
  edgeT: number;
  /** Lock strength (increases over time while locked, affects escape threshold) */
  lockStrength: number;
  /** Is this a corner (vertex where 2+ edges meet)? */
  isCorner: boolean;
  /** Number of edges meeting at corner (valence) */
  cornerValence: number;
}

// ============================================================================
// Section Plane Types
// ============================================================================

/** Semantic axis names: down (Y), front (Z), side (X) for intuitive user experience */
export type SectionPlaneAxis = 'down' | 'front' | 'side';

// Re-export the renderer's canonical cap-styling types so the viewer store and
// the WebGPU renderer share a single source of truth. Adding a new hatch
// pattern only requires editing `packages/renderer/src/section-cap-style.ts`.
export type { HatchPatternId as SectionCapHatchId, SectionCapStyle } from '@ifc-lite/renderer';
import type { SectionCapStyle } from '@ifc-lite/renderer';

/**
 * Custom (face-picked) plane override. When present, the renderer uses
 * `normal` + `distance` directly and ignores `axis` / `position`. The
 * cardinal `axis` / `position` / `flipped` fields are still kept in sync
 * (nearest-cardinal for axis, percentage along it for position) so any
 * downstream reader that pre-dates custom planes (drawings export, BCF
 * snapshots, view controls) still gets a sensible projection rather than
 * crashing or emitting empty data.
 *
 * Tangent + bitangent are derived once at pick time from `normal` via the
 * deterministic `planeBasis` helper so the cap shader and cutter share
 * exactly one orientation — without this the cap-hatch can rotate when
 * the renderer re-derives the basis on every frame.
 */
export interface CustomSectionPlane {
  /** Unit world-space normal. */
  normal: [number, number, number];
  /** Signed plane offset in world units: `dot(pointOnPlane, normal)`. */
  distance: number;
  /** World-space hit point at pick time (anchors the slider re-mapping). */
  pickedAt: [number, number, number];
  /** First in-plane axis, deterministic from `normal`. */
  tangent: [number, number, number];
  /** Second in-plane axis, deterministic from `normal`. */
  bitangent: [number, number, number];
}

export interface SectionPlane {
  axis: SectionPlaneAxis;
  /** 0-100 percentage of model bounds */
  position: number;
  enabled: boolean;
  /** If true, show the opposite side of the cut */
  flipped: boolean;
  /** Whether to render the filled, hatched cap surface at the plane. Defaults to true. */
  showCap: boolean;
  /**
   * Whether to draw polygon outlines on top of the cut (the crisp black
   * line the architect expects around each sliced element). Independent
   * from `showCap` so users can have a hatched fill without outlines,
   * or vice versa. Defaults to true.
   */
  showOutlines: boolean;
  /** User-defined colour + hatch for the cut surface. */
  capStyle: SectionCapStyle;
  /**
   * Optional arbitrary-normal override populated by face-pick. When set,
   * the renderer cuts on this plane verbatim; cardinal `axis` / `position`
   * are kept in sync as the closest cardinal projection (see
   * `CustomSectionPlane`).
   */
  custom?: CustomSectionPlane;
}

// ============================================================================
// Hover & Context Menu Types
// ============================================================================

export interface HoverState {
  entityId: number | null;
  screenX: number;
  screenY: number;
  /**
   * World-space hit position from the GPU pick (depth readback +
   * inverse view-projection). Unset when the picker couldn't recover
   * one (e.g. `pointCount === 0` clear, or the pick fell on the
   * background). Useful for point-cloud hover tooltips where the
   * synthetic entity has no surface property to display.
   */
  worldXYZ?: { x: number; y: number; z: number };
}

export interface ContextMenuState {
  isOpen: boolean;
  entityId: number | null;
  screenX: number;
  screenY: number;
}

// ============================================================================
// Snap Visualization Types
// ============================================================================

export interface SnapVisualization {
  /** 3D world coordinates for edge (projected to screen by renderer) */
  edgeLine3D?: { v0: { x: number; y: number; z: number }; v1: { x: number; y: number; z: number } };
  /** Face snap indicator */
  planeIndicator?: { x: number; y: number; normal: { x: number; y: number; z: number } };
  /** Position on edge (t = 0-1), projected from edgeLine3D */
  slidingDot?: { t: number };
  /** Corner indicator: true = at v0, false = at v1 */
  cornerRings?: { atStart: boolean; valence: number };
}

// ============================================================================
// Type Visibility
// ============================================================================

export interface TypeVisibility {
  /** IfcSpace - off by default */
  spaces: boolean;
  /**
   * IfcSpatialZone (modelled GFA volumes) - off by default, its own toggle
   * separate from `spaces` so net (room) and gross (zone) areas can be shown
   * independently (issue #1075).
   */
  spatialZones: boolean;
  /** IfcOpeningElement - off by default */
  openings: boolean;
  /**
   * IfcVirtualElement - off by default. Non-physical placeholders (space
   * boundaries, "free space"/clearance volumes around stairs) that carry
   * geometry in some exports but aren't real building elements; rendering them
   * clutters the view with translucent boxes (issue #1133).
   */
  virtualElements: boolean;
  /** IfcSite - on by default (when has geometry) */
  site: boolean;
  /** IfcAnnotation (2D symbolic curves) - on by default when present */
  ifcAnnotations: boolean;
  /**
   * IfcGrid axis lines + bubble tags — split from `ifcAnnotations`
   * (issue #862). Default true to match the legacy combined behaviour;
   * users with dense grids that obscure components can hide grids while
   * keeping annotations on. Unlike `ifcAnnotations`, grids are also
   * section-clipped when a 3D section plane is active so each storey's
   * grid lines only show for storeys near the cut.
   */
  ifcGrid: boolean;
}

// ============================================================================
// Camera Types
// ============================================================================

export interface CameraRotation {
  azimuth: number;
  elevation: number;
}

export type ProjectionMode = 'perspective' | 'orthographic';

export interface CameraViewpoint {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  fov: number;
  projectionMode: ProjectionMode;
  orthoSize?: number;
}

export interface CameraCallbacks {
  setPresetView?: (view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right') => void;
  fitAll?: () => void;
  home?: () => void;
  zoomIn?: () => void;
  zoomOut?: () => void;
  /** Rotate the camera exactly 90° around the vertical axis. */
  rotateLeft?: () => void;
  /** Rotate the camera exactly 90° around the vertical axis. */
  rotateRight?: () => void;
  frameSelection?: () => void;
  /**
   * Resolve ids to what the 3D renderer can actually highlight, expanding a
   * geometry-less `IfcRelAggregates` assembly (own id has no mesh) to its
   * geometry-bearing parts — the same resolution `frameSelection` applies to
   * decide what to frame. For a selection entry point that assigns
   * `selectedEntityId`/`selectedEntityIds` directly (search modal, programmatic
   * select) rather than a 3D pick, calling this before setting the selection
   * keeps "camera moved here" and "this is highlighted" in agreement. Returns
   * `[]` for an id with neither geometry nor renderable parts.
   */
  resolveHighlightIds?: (ids: number[]) => number[];
  /**
   * Frame the camera on the bounds of an explicit id set, keeping the current
   * view direction. Ids are federated GLOBAL ids — the id space the scene
   * meshes carry (single model: global === express). Used by the Space Sketch
   * tool to zoom to the existing IfcSpace extent on open.
   */
  frameEntities?: (ids: number[]) => void;
  /**
   * Frame the camera on the building shell - the bounds of all rendered
   * geometry EXCLUDING IfcSite/terrain and IfcSpace. Used by the Space Sketch
   * tool when a model has no spaces yet, so it frames the building rather than
   * the much larger georeferenced site extent.
   */
  frameBuildingExtent?: () => void;
  /**
   * Replace the Space Sketch draft "ghost" overlay meshes in the 3D scene. These
   * go straight to the renderer scene (NOT through geometryResult), so frequent
   * per-edit updates can't trip the streaming reclassifier (which would reset the
   * camera / un-pick newly created spaces). Pass [] (or use clear) to remove all.
   */
  setSpaceOverlayMeshes?: (meshes: MeshData[]) => void;
  /** Remove all Space Sketch overlay ghost meshes from the scene. */
  clearSpaceOverlayMeshes?: () => void;
  /**
   * Frame an explicit world-space box (min/max corners) from the canonical
   * isometric view, animating there. Used to frame a focused clash's contact
   * region head-on (#1466) rather than `frameSelection`, which unions the
   * selected elements' full bounds and keeps the current (often top-down) view
   * direction, so a long clashing member dominates and the overlap reads small.
   */
  frameClashRegion?: (min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }) => void;
  orbit?: (deltaX: number, deltaY: number) => void;
  projectToScreen?: (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null;
  /**
   * Unproject a screen pixel onto the horizontal plane at the
   * specified world Y. Used by drag handles (wall endpoints,
   * georeference move) to convert a cursor position back into
   * world coordinates on the storey floor. Returns null when the
   * camera ray is parallel to the plane or points the wrong way.
   */
  unprojectToFloor?: (clientX: number, clientY: number, worldY: number) => { x: number; y: number; z: number } | null;
  setProjectionMode?: (mode: ProjectionMode) => void;
  toggleProjectionMode?: () => void;
  getProjectionMode?: () => ProjectionMode;
  getViewpoint?: () => CameraViewpoint | null;
  applyViewpoint?: (viewpoint: CameraViewpoint, animate?: boolean, durationMs?: number) => void;
}

// ============================================================================
// Multi-Model Federation Types
// ============================================================================

import type { IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo, EntityWorldAabb, GeometryResult, MeshData } from '@ifc-lite/geometry';

/**
 * Compound identifier for entities across multiple models.
 *
 * Structurally identical to `@ifc-lite/sdk`'s EntityRef, but
 * defined locally because the desktop app bundles viewer source
 * via tsconfig path aliases and does not declare `@ifc-lite/sdk`
 * as a workspace dep — re-exporting from the SDK breaks the
 * desktop Vite build with an unresolvable module. Keep the
 * shapes in sync manually; both packages exhaustively test
 * EntityRef-shaped values, so drift will surface at the
 * federation boundary.
 */
export interface EntityRef {
  modelId: string;
  expressId: number;
}

/** IFC schema version enum for type safety */
export type SchemaVersion = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';

export type GeometryLoadState =
  | 'pending'
  | 'opening'
  | 'streaming'
  | 'interactive'
  | 'complete'
  | 'error';

export type MetadataLoadState =
  | 'idle'
  | 'bootstrapping'
  | 'spatial-ready'
  | 'lazy'
  | 'querying'
  | 'complete'
  | 'error';

export type ModelSourceFile = File;

/** Complete model container for federation */
/**
 * A federated model's geometry as it stood before alignment re-baked it.
 *
 * The whole set of channels `federationAlign.ts` overwrites — anything it
 * writes has to be in here or the restore is incomplete. Captured and restored
 * by the one pair of functions in `hooks/ingest/federationRealign.ts`.
 */
export interface PreAlignmentSnapshot {
  /** One Float32Array per mesh, in `geometryResult.meshes` order. */
  positions: Float32Array[];
  /** Per mesh, sparse: `undefined` where the mesh carried no normals. Restored
   *  because alignment rotates normals in place, so repeated re-bakes would
   *  compound the rotation and drift the shading. */
  normals: (Float32Array | undefined)[];
  /**
   * Per mesh, sparse: the local-frame origin (`world = origin + position`),
   * `undefined` where the mesh carried none.
   *
   * Alignment folds each origin into the vertices and then ZEROES it — it does
   * not remove it — so there is no safe "leave the origin alone" reading of a
   * restore: leaving the zero misplaces the mesh by exactly the offset that was
   * folded in, which is the same damage as deleting it. Only putting the true
   * value back is correct. Measured at up to 54 m of displacement on the second
   * re-align of `Infra-Bridge.ifc`, and every model off the wasm local-frame
   * path carries origins.
   */
  origins: ([number, number, number] | undefined)[];
  /** The RTC/shift frame the positions are relative to, recovered before the
   *  new alignment is applied. */
  coordinateInfo: CoordinateInfo;
  /**
   * Per mesh, sparse: the per-entity world box (#1891), `undefined` where the
   * mesh carried none. Alignment REPLACES each box with one in the anchor's
   * frame, so a re-align run against already-aligned boxes would transform them
   * twice while the vertices started over from the snapshot — the box and its
   * mesh would part company again, silently.
   *
   * References, not copies: alignment never mutates a box in place, so the
   * snapshotted objects stay valid pre-alignment values.
   */
  geometryAabbs: (EntityWorldAabb | undefined)[];
  /**
   * `geometryResult.instancedGeometryAabbs`, where `undefined` is a VALUE — the
   * model had no instanced-only channel — and not a missing snapshot. Restoring
   * it unconditionally is what keeps capture and restore asking the same
   * question (#2005).
   */
  instancedGeometryAabbs: Map<number, EntityWorldAabb> | undefined;
}

export interface FederatedModel {
  /** Unique identifier (UUID generated on load) */
  id: string;
  /** Display name (filename by default, user can rename) */
  name: string;
  /** Parsed IFC data model */
  ifcDataStore: IfcDataStore | null;
  /** Pre-tessellated geometry (with globalIds, not original expressIds) */
  geometryResult: GeometryResult | null;
  /** Model-level visibility toggle */
  visible: boolean;
  /** UI collapse state in hierarchy panel */
  collapsed: boolean;
  /** IFC schema version */
  schemaVersion: SchemaVersion;
  /** Load timestamp */
  loadedAt: number;
  /** Original file size in bytes */
  fileSize: number;
  /** Original source handle used for explicit reload/reposition operations. */
  sourceFile?: ModelSourceFile;
  /**
   * Live File System Access handle captured when the model was opened on a
   * Chromium browser, via the picker (`showOpenFilePicker`) or by drag-drop
   * (`DataTransferItem.getAsFileSystemHandle`), through the toolbar, the
   * empty-state open, the command palette, or Add Model. Unlike `sourceFile`
   * (a frozen snapshot of the bytes at pick time), this can be re-read with
   * `getFile()` to pull the current on-disk contents, powering the "Refresh"
   * action (issue #1345). Absent for the `<input type="file">` fallback
   * (Firefox/Safari/insecure context), cache-restored models, and IFCX-composed
   * layers. Held in memory only; never serialized to cache.
   */
  sourceHandle?: FileSystemFileHandle;
  /**
   * ID offset for this model (from FederationRegistry)
   * All mesh expressIds are globalIds = originalExpressId + idOffset
   * Use this to convert back to original IDs for property lookup
   */
  idOffset: number;
  /** Maximum original expressId in this model (for range validation) */
  maxExpressId: number;
  /** Unified ingest lifecycle state. */
  loadState?: 'pending' | 'streaming-geometry' | 'hydrating-metadata' | 'complete' | 'error';
  /** Geometry-first readiness for large desktop loads. */
  geometryLoadState?: GeometryLoadState;
  /** Metadata availability state for lazy desktop loads. */
  metadataLoadState?: MetadataLoadState;
  /** True once the model is visibly interactive in the viewport. */
  interactiveReady?: boolean;
  /** Cache state for the current load session. */
  cacheState?: 'none' | 'hit' | 'miss' | 'writing';
  /** Optional load error for this model. */
  loadError?: string | null;
  /**
   * Renderer handle for a streamed point cloud (LAS/LAZ) attached to
   * this model. Stored as a plain number so the field stays JSON-safe.
   * The viewport's removal effect calls `renderer.removePointCloudAsset`
   * when the model is dropped from the store.
   */
  pointCloudHandleId?: number;
  /**
   * This model's geometry as it stood before federation alignment re-baked it
   * into the anchor's viewer frame, or `undefined` when no alignment is applied
   * — a single-model load, the federation anchor itself, or a model that was
   * restored back into its own frame.
   *
   * ONE object rather than a field per channel, on purpose. Every channel here
   * is something the alignment overwrites, and a restore that puts back some of
   * them and not others is the defect this whole path keeps producing (#2005
   * lost the world boxes, #2007 the anchor, and the local-frame origins were
   * never captured at all). Grouping them makes "positions but no origins"
   * unrepresentable instead of merely unreachable: capture and restore cannot
   * drift apart, because there is one value to write and one to read.
   */
  preAlignment?: PreAlignmentSnapshot;
  /**
   * How this model was placed in the current federation:
   *   - `'anchor'`       — this model drives the world frame, no alignment
   *   - `'same-crs'`     — vertex transform applied (shared projected CRS)
   *   - `'reprojected'`  — per-vertex proj4 hop into the anchor's CRS
   *   - `'identity'`     — same CRS and same MapConversion → no change needed
   *   - `'failed'`       — alignment could not be computed; model rendered in
   *                        its own local frame and likely at the wrong real
   *                        world position
   *   - `'none'`         — single-model load, first georeferenced model, or a
   *                        model that could not take part in the last
   *                        federation re-align (no geometry, or no georeference)
   */
  federationAlignmentStatus?: 'anchor' | 'same-crs' | 'reprojected' | 'identity' | 'failed' | 'none';
}

/**
 * Convert EntityRef to string for use as Map/Set key.
 *
 * NOTE: `packages/sdk/src/types.ts` carries a second implementation of this
 * pair with a THROWING contract and a LAST-colon split. Deliberate, not
 * drift: this side decodes untrusted DOM/state strings on hot paths and
 * must not throw (a sentinel `{ modelId: '', expressId: -1 }` instead), and
 * a published API is free to fail loudly at the corruption site. Keep the
 * two in step on *bugs*, not on contract.
 */
export function entityRefToString(ref: EntityRef): string {
  return `${ref.modelId}:${ref.expressId}`;
}

/** Parse string back to EntityRef */
export function stringToEntityRef(str: string): EntityRef {
  const colonIndex = str.indexOf(':');
  if (colonIndex === -1) {
    // Invalid format - return a sentinel value
    return { modelId: '', expressId: -1 };
  }
  const modelId = str.substring(0, colonIndex);
  const expressId = parseInt(str.substring(colonIndex + 1), 10);
  // Handle NaN case (malformed expressId)
  if (Number.isNaN(expressId)) {
    return { modelId, expressId: -1 };
  }
  return { modelId, expressId };
}

/** Check if two EntityRefs are equal */
export function entityRefEquals(a: EntityRef | null, b: EntityRef | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.modelId === b.modelId && a.expressId === b.expressId;
}

/**
 * Type guard to check if a data store has IFC5 schema version.
 * IFCX files are stored with schemaVersion: 'IFC5' which extends the parser's IfcDataStore type.
 */
export function isIfcxDataStore(dataStore: unknown): boolean {
  return (
    dataStore !== null &&
    typeof dataStore === 'object' &&
    'schemaVersion' in dataStore &&
    dataStore.schemaVersion === 'IFC5'
  );
}
