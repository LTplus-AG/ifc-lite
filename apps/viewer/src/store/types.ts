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
}

// ============================================================================
// Hover & Context Menu Types
// ============================================================================

export interface HoverState {
  entityId: number | null;
  screenX: number;
  screenY: number;
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
import type { GeometryResult } from '@ifc-lite/geometry';

/** Compound identifier for entities across multiple models */
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
