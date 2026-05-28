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
  /** IfcOpeningElement - off by default */
  openings: boolean;
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
  frameSelection?: () => void;
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
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';

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

export interface NativeMetadataProperty {
  name: string;
  value: string | number | boolean | null;
  type?: number;
}

export interface NativeMetadataPropertySet {
  name: string;
  globalId?: string;
  properties: NativeMetadataProperty[];
}

export interface NativeMetadataQuantity {
  name: string;
  value: number;
  type?: number;
}

export interface NativeMetadataQuantitySet {
  name: string;
  quantities: NativeMetadataQuantity[];
}

export interface NativeMetadataEntitySummary {
  expressId: number;
  type: string;
  name: string;
  globalId?: string | null;
  kind: 'spatial' | 'element';
  hasChildren: boolean;
  elementCount?: number;
  elevation?: number | null;
}

export interface NativeMetadataSpatialNode extends NativeMetadataEntitySummary {
  children: NativeMetadataSpatialNode[];
  elements: NativeMetadataEntitySummary[];
}

export interface NativeMetadataSpatialInfo {
  storeyId?: number | null;
  storeyName?: string | null;
  elevation?: number | null;
  height?: number | null;
}

export interface NativeMetadataEntityDetails {
  summary: NativeMetadataEntitySummary;
  typeSummary?: NativeMetadataEntitySummary | null;
  spatial?: NativeMetadataSpatialInfo | null;
  properties: NativeMetadataPropertySet[];
  quantities: NativeMetadataQuantitySet[];
}

export interface NativeMetadataSnapshot {
  mode: 'desktop-lazy';
  cacheKey: string;
  filePath: string;
  schemaVersion: SchemaVersion;
  entityCount: number;
  spatialTree: NativeMetadataSpatialNode | null;
}

export type ModelSourceFile = File | {
  path: string;
  name: string;
  size: number;
  modifiedMs?: number | null;
};

/** Complete model container for federation */
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
  /** Optional sparse desktop metadata snapshot for huge native loads. */
  nativeMetadata?: NativeMetadataSnapshot | null;
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
   * Snapshot of mesh positions before federation alignment ran (one Float32Array
   * per mesh, indexed in `geometryResult.meshes` order). Populated when this
   * model joined an existing federation and its geometry was re-baked into the
   * anchor's viewer frame. Used by `realignFederation()` to re-apply alignment
   * against a different anchor without re-parsing the source file.
   *
   * Stays `undefined` for single-model loads and the federation anchor itself
   * (which has no alignment applied).
   */
  preAlignmentPositions?: Float32Array[];
  /**
   * Snapshot of mesh normals before federation alignment ran (one Float32Array
   * per mesh, sparse — empty slot when a mesh had no normals). Restored
   * alongside `preAlignmentPositions` on re-alignment so repeated re-bakes
   * don't accumulate rotation drift on the normals (lighting/shading bug).
   */
  preAlignmentNormals?: (Float32Array | undefined)[];
  /**
   * CoordinateInfo at the time `preAlignmentPositions` was taken. Restored
   * together with the positions on re-alignment so the source's RTC/shift
   * frame is recovered before applying the new alignment.
   */
  preAlignmentCoordinateInfo?: CoordinateInfo;
  /**
   * How this model was placed in the current federation:
   *   - `'anchor'`       — this model drives the world frame, no alignment
   *   - `'same-crs'`     — vertex transform applied (shared projected CRS)
   *   - `'reprojected'`  — per-vertex proj4 hop into the anchor's CRS
   *   - `'identity'`     — same CRS and same MapConversion → no change needed
   *   - `'failed'`       — alignment could not be computed; model rendered in
   *                        its own local frame and likely at the wrong real
   *                        world position
   *   - `'none'`         — single-model load or first georeferenced model
   */
  federationAlignmentStatus?: 'anchor' | 'same-crs' | 'reprojected' | 'identity' | 'failed' | 'none';
}

/** Convert EntityRef to string for use as Map/Set key */
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
