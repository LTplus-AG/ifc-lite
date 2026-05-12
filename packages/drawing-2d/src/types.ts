/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Core types for 2D architectural drawing generation
 */

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

export type SectionAxis = 'x' | 'y' | 'z';

export interface SectionPlaneConfig {
  /** Axis perpendicular to the section plane */
  axis: SectionAxis;
  /** Position along the axis in world units */
  position: number;
  /** Whether to flip the view direction */
  flipped: boolean;
  /**
   * Optional arbitrary-normal override (issue #243). When supplied, the
   * cutter uses this plane verbatim (`dot(p, normal) = distance`) and
   * projects intersection points to 2D via `(dot(p − origin, tangent),
   * dot(p − origin, bitangent))`. The cardinal `axis` / `position` /
   * `flipped` fields are then only used by downstream code that pre-dates
   * arbitrary planes (e.g. legacy SVG export); the geometry produced by
   * the cutter itself is correct for the explicit plane.
   *
   * `tangent` and `bitangent` MUST be the same basis the cap renderer
   * uses (`planeBasis(normal)` from `@ifc-lite/renderer`) so the round-
   * trip 3D→2D→3D in the cap pipeline stays exact.
   */
  customPlane?: {
    normal:    Vec3;
    /** Plane offset: `dot(pointOnPlane, normal)`. */
    distance:  number;
    /** Origin = the projected pick point on the plane (basis origin). */
    origin:    Vec3;
    tangent:   Vec3;
    bitangent: Vec3;
  };
}

export interface SectionConfig {
  /** Section plane definition */
  plane: SectionPlaneConfig;
  /** Depth range beyond cut plane to include for projection lines (world units) */
  projectionDepth: number;
  /** Whether to compute hidden lines */
  includeHiddenLines: boolean;
  /** Crease angle threshold in degrees (edges sharper than this are feature edges) */
  creaseAngle: number;
  /** Scale factor for output (e.g., 100 for 1:100) */
  scale: number;
}

export const DEFAULT_SECTION_CONFIG: Omit<SectionConfig, 'plane'> = {
  projectionDepth: 10,
  includeHiddenLines: true,
  creaseAngle: 30,
  scale: 100,
};

// ═══════════════════════════════════════════════════════════════════════════
// 2D GEOMETRY PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════

export interface Point2D {
  x: number;
  y: number;
}

export interface Line2D {
  start: Point2D;
  end: Point2D;
}

export interface Polyline2D {
  points: Point2D[];
  closed: boolean;
}

export interface Polygon2D {
  /** Outer boundary (counter-clockwise winding) */
  outer: Point2D[];
  /** Inner holes (clockwise winding) */
  holes: Point2D[][];
}

export interface Bounds2D {
  min: Point2D;
  max: Point2D;
}

// ═══════════════════════════════════════════════════════════════════════════
// LINE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Category of line in architectural drawing
 */
export type LineCategory =
  | 'cut'         // Geometry intersected by section plane (thickest lines)
  | 'projection'  // Visible geometry beyond cut plane
  | 'hidden'      // Occluded geometry (rendered as dashed)
  | 'silhouette'  // Outer contour edges
  | 'crease'      // Sharp feature edges (angle > threshold)
  | 'boundary'    // Mesh boundary edges (open edges)
  | 'annotation'; // Dimensions, labels, etc.

/**
 * Visibility state for hidden line removal
 */
export type VisibilityState = 'visible' | 'hidden' | 'partial';

// ═══════════════════════════════════════════════════════════════════════════
// DRAWING ELEMENTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A classified line segment in the 2D drawing
 */
export interface DrawingLine {
  /** 2D line geometry */
  line: Line2D;
  /** Line classification */
  category: LineCategory;
  /** Visibility after hidden line removal */
  visibility: VisibilityState;
  /** Source IFC entity expressId */
  entityId: number;
  /** IFC type name (e.g., "IfcWall") */
  ifcType: string;
  /** Model index for multi-model federation */
  modelIndex: number;
  /** Distance from section plane (for depth sorting) */
  depth: number;
}

/**
 * A polygon from section cut (used for hatching)
 */
export interface DrawingPolygon {
  /** 2D polygon geometry */
  polygon: Polygon2D;
  /** Source IFC entity expressId */
  entityId: number;
  /** IFC type name */
  ifcType: string;
  /** Model index for multi-model federation */
  modelIndex: number;
  /** True if from section cut, false if projection */
  isCut: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERMEDIATE RESULTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Raw cut segment before classification
 */
export interface CutSegment {
  /** 3D start point of cut */
  p0: Vec3;
  /** 3D end point of cut */
  p1: Vec3;
  /** 2D projected start point */
  p0_2d: Point2D;
  /** 2D projected end point */
  p1_2d: Point2D;
  /** Source entity ID */
  entityId: number;
  /** IFC type */
  ifcType: string;
  /** Model index */
  modelIndex: number;
}

/**
 * Result from section cutting a single mesh
 */
export interface MeshCutResult {
  /** Cut line segments */
  segments: CutSegment[];
  /** Number of triangles processed */
  trianglesProcessed: number;
  /** Number of triangles that intersected the plane */
  trianglesIntersected: number;
}

/**
 * Result from cutting all meshes
 */
export interface SectionCutResult {
  /** All cut segments */
  segments: CutSegment[];
  /** Reconstructed polygons per entity */
  polygons: DrawingPolygon[];
  /** Processing statistics */
  stats: {
    totalTriangles: number;
    intersectedTriangles: number;
    segmentCount: number;
    polygonCount: number;
    processingTimeMs: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPLETE DRAWING OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Complete 2D drawing result
 */
export interface Drawing2D {
  /** Section configuration used */
  config: SectionConfig;

  /** All classified lines */
  lines: DrawingLine[];

  /** Cut polygons (for hatching) */
  cutPolygons: DrawingPolygon[];

  /** Projection polygons (visible surfaces beyond cut) */
  projectionPolygons: DrawingPolygon[];

  /** Bounding box in 2D drawing space */
  bounds: Bounds2D;

  /** Processing statistics */
  stats: {
    cutLineCount: number;
    projectionLineCount: number;
    hiddenLineCount: number;
    silhouetteLineCount: number;
    polygonCount: number;
    totalTriangles: number;
    processingTimeMs: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EDGE DATA (for feature edge extraction)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Edge data with adjacency information
 */
export interface EdgeData {
  /** First vertex */
  v0: Vec3;
  /** Second vertex */
  v1: Vec3;
  /** Normal of first adjacent face (null if boundary) */
  face0Normal: Vec3 | null;
  /** Normal of second adjacent face (null if boundary) */
  face1Normal: Vec3 | null;
  /** Dihedral angle between faces (radians) */
  dihedralAngle: number;
  /** Edge classification */
  type: 'crease' | 'boundary' | 'smooth';
  /** Source entity ID */
  entityId: number;
  /** IFC type */
  ifcType: string;
  /** Model index */
  modelIndex: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROFILE ENTRY (from WASM extractProfiles)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A raw profile polygon extracted from an IfcExtrudedAreaSolid element.
 *
 * All geometry is in **WebGL Y-up world space** (metres).
 * Applying `transform` to `[x, y, 0, 1]` yields the world-space 3D position.
 *
 * Returned by `IfcAPI.extractProfiles()` (WASM).
 */
export interface ProfileEntry {
  /** Express ID of the building element. */
  expressId: number;
  /** IFC type name (e.g., `"IfcWall"`). */
  ifcType: string;
  /** Outer boundary: flat `[x0, y0, x1, y1, …]` in local profile space (metres). */
  outerPoints: Float32Array;
  /** Number of points per hole. */
  holeCounts: Uint32Array;
  /** All hole points concatenated in local profile space (metres). */
  holePoints: Float32Array;
  /**
   * 4 × 4 **column-major** transform in WebGL Y-up world space.
   * `M * [x, y, 0, 1]ᵀ` → world position.
   */
  transform: Float32Array;
  /** Extrusion direction `[dx, dy, dz]` in WebGL Y-up world space (unit vector). */
  extrusionDir: Float32Array;
  /** Extrusion depth in metres. */
  extrusionDepth: number;
  /** Model index for multi-model federation. */
  modelIndex: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Entity key for grouping geometry
 */
export type EntityKey = `${number}:${number}`; // modelIndex:entityId

/**
 * Create entity key from components
 */
export function makeEntityKey(modelIndex: number, entityId: number): EntityKey {
  return `${modelIndex}:${entityId}`;
}

/**
 * Parse entity key back to components
 */
export function parseEntityKey(key: EntityKey): { modelIndex: number; entityId: number } {
  const parts = key.split(':');
  if (parts.length !== 2) {
    throw new Error(`Invalid entity key format: "${key}". Expected "modelIndex:entityId"`);
  }
  const modelIndex = Number(parts[0]);
  const entityId = Number(parts[1]);
  if (!Number.isFinite(modelIndex) || !Number.isFinite(entityId)) {
    throw new Error(`Invalid entity key values: "${key}". Both modelIndex and entityId must be valid numbers`);
  }
  return { modelIndex, entityId };
}

// ═══════════════════════════════════════════════════════════════════════════
// OPENING AND RELATIONSHIP TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Door operation type (from IFC IfcDoorTypeOperationEnum)
 */
export type DoorOperationType =
  | 'SINGLE_SWING_LEFT'
  | 'SINGLE_SWING_RIGHT'
  | 'DOUBLE_DOOR_SINGLE_SWING'
  | 'DOUBLE_DOOR_DOUBLE_SWING'
  | 'DOUBLE_SWING_LEFT'
  | 'DOUBLE_SWING_RIGHT'
  | 'SLIDING_TO_LEFT'
  | 'SLIDING_TO_RIGHT'
  | 'DOUBLE_DOOR_SLIDING'
  | 'FOLDING_TO_LEFT'
  | 'FOLDING_TO_RIGHT'
  | 'DOUBLE_DOOR_FOLDING'
  | 'REVOLVING'
  | 'ROLLINGUP'
  | 'SWING_FIXED_LEFT'
  | 'SWING_FIXED_RIGHT'
  | 'USERDEFINED'
  | 'NOTDEFINED';

/**
 * Window operation type (from IFC IfcWindowTypePartitioningEnum)
 */
export type WindowPartitioningType =
  | 'SINGLE_PANEL'
  | 'DOUBLE_PANEL_VERTICAL'
  | 'DOUBLE_PANEL_HORIZONTAL'
  | 'TRIPLE_PANEL_VERTICAL'
  | 'TRIPLE_PANEL_HORIZONTAL'
  | 'TRIPLE_PANEL_BOTTOM'
  | 'TRIPLE_PANEL_TOP'
  | 'TRIPLE_PANEL_LEFT'
  | 'TRIPLE_PANEL_RIGHT'
  | 'USERDEFINED'
  | 'NOTDEFINED';

/**
 * Information about an opening (door, window, or void)
 */
export interface OpeningInfo {
  /** Type of opening */
  type: 'door' | 'window' | 'opening';
  /** Express ID of the opening element */
  openingId: number;
  /** Express ID of the host element (wall, slab, etc.) */
  hostElementId: number;
  /** Express ID of the filling element (door/window), if any */
  fillingElementId?: number;
  /** IFC type of the filling element */
  fillingType?: string;
  /** Opening width in world units */
  width: number;
  /** Opening height in world units */
  height: number;
  /** 3D bounding box of the opening */
  bounds3D: {
    min: Vec3;
    max: Vec3;
  };
  /** Door operation type (for doors) */
  doorOperation?: DoorOperationType;
  /** Window partitioning type (for windows) */
  windowPartitioning?: WindowPartitioningType;
  /** Model index for multi-model federation */
  modelIndex: number;
}

/**
 * Relationship data for opening-aware drawing generation
 */
export interface OpeningRelationships {
  /** Map of host element ID to opening IDs that void it */
  voidedBy: Map<number, number[]>;
  /** Map of opening ID to filling element ID (door/window) */
  filledBy: Map<number, number>;
  /** Map of opening/filling element ID to opening info */
  openingInfo: Map<number, OpeningInfo>;
}

/**
 * Void relationship from IfcRelVoidsElement
 */
export interface VoidRelationship {
  /** Host element express ID (wall, slab, etc.) */
  hostId: number;
  /** Opening element express ID */
  openingId: number;
}

/**
 * Fill relationship from IfcRelFillsElement
 */
export interface FillRelationship {
  /** Opening element express ID */
  openingId: number;
  /** Filling element express ID (door, window) */
  elementId: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// LINE WEIGHT AND STYLE TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Line weight classification for architectural drawings
 */
export type LineWeight = 'heavy' | 'medium' | 'light' | 'hairline';

/**
 * Line style for different element types
 */
export type LineStyle = 'solid' | 'dashed' | 'dotted' | 'centerline' | 'phantom';

/**
 * Semantic line type for architectural categorization
 */
export type SemanticLineType =
  | 'wall-cut'
  | 'wall-projection'
  | 'column-cut'
  | 'slab-cut'
  | 'opening-frame'
  | 'door-swing'
  | 'door-leaf'
  | 'window-frame'
  | 'window-mullion'
  | 'stair-cut'
  | 'stair-nosing'
  | 'furniture'
  | 'equipment'
  | 'annotation'
  | 'dimension'
  | 'hidden'
  | 'centerline';

/**
 * Line weight configuration
 */
export interface LineWeightConfig {
  weight: LineWeight;
  /** Width in mm for SVG output */
  widthMm: number;
  style: LineStyle;
}

/**
 * Extended drawing line with architectural styling
 */
export interface ArchitecturalLine extends DrawingLine {
  /** Line weight for rendering */
  lineWeight: LineWeight;
  /** Line style (solid, dashed, etc.) */
  lineStyle: LineStyle;
  /** Semantic type for layer assignment */
  semanticType: SemanticLineType;
}

// ═══════════════════════════════════════════════════════════════════════════
// ARCHITECTURAL SYMBOL TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Type of architectural symbol
 */
export type SymbolType =
  | 'door-swing'
  | 'door-sliding'
  | 'door-folding'
  | 'door-revolving'
  | 'window-frame'
  | 'stair-arrow'
  | 'north-arrow'
  | 'section-mark'
  | 'level-mark';

/**
 * Architectural symbol for 2D drawings
 */
export interface ArchitecturalSymbol {
  /** Symbol type */
  type: SymbolType;
  /** Position in 2D drawing space */
  position: Point2D;
  /** Rotation angle in radians */
  rotation: number;
  /** Scale factor */
  scale: number;
  /** Symbol-specific parameters */
  parameters: SymbolParameters;
  /** Associated entity ID (if any) */
  entityId?: number;
  /** Model index */
  modelIndex?: number;
}

/**
 * Parameters for door swing symbol
 */
export interface DoorSwingParameters {
  /** Door leaf width */
  width: number;
  /** Swing direction: 1 = counter-clockwise, -1 = clockwise */
  swingDirection: 1 | -1;
  /** Swing angle in radians (typically π/2) */
  swingAngle: number;
  /** Hinge position */
  hingePoint: Point2D;
  /** Whether this is a double door */
  isDouble: boolean;
}

/**
 * Parameters for sliding door symbol
 */
export interface SlidingDoorParameters {
  /** Door panel width */
  width: number;
  /** Slide direction: 1 = positive, -1 = negative */
  slideDirection: 1 | -1;
  /** Number of panels */
  panelCount: number;
}

/**
 * Parameters for window frame symbol
 */
export interface WindowFrameParameters {
  /** Window width */
  width: number;
  /** Frame depth (thickness shown in plan) */
  frameDepth: number;
  /** Number of mullions */
  mullionCount: number;
}

/**
 * Parameters for stair arrow symbol
 */
export interface StairArrowParameters {
  /** Direction: 'up' or 'down' */
  direction: 'up' | 'down';
  /** Arrow length */
  length: number;
  /** Number of risers to label */
  riserCount?: number;
}

/**
 * Union type for all symbol parameters
 */
export type SymbolParameters =
  | DoorSwingParameters
  | SlidingDoorParameters
  | WindowFrameParameters
  | StairArrowParameters
  | Record<string, number | string | boolean>;

// ═══════════════════════════════════════════════════════════════════════════
// LAYER TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * AIA layer naming convention codes
 */
export type AIALayerCode =
  | 'A-WALL'      // Walls
  | 'A-WALL-FULL' // Full-height walls
  | 'A-WALL-PRHT' // Partial-height walls
  | 'A-DOOR'      // Doors
  | 'A-GLAZ'      // Glazing/Windows
  | 'A-COLS'      // Columns
  | 'A-FLOR'      // Floor information
  | 'A-CLNG'      // Ceiling information
  | 'A-ROOF'      // Roof information
  | 'A-STRS'      // Stairs
  | 'A-FURN'      // Furniture
  | 'A-EQPM'      // Equipment
  | 'A-PATT'      // Hatching patterns
  | 'A-ANNO'      // Annotations
  | 'A-DIMS'      // Dimensions
  | 'A-SYMB'      // Symbols
  | 'A-DETL'      // Details
  | 'A-ELEV'      // Elevations
  | 'A-SECT'      // Sections
  | 'A-HIDN';     // Hidden lines

/**
 * Layer definition for SVG export
 */
export interface LayerDefinition {
  /** Layer ID (for SVG) */
  id: string;
  /** AIA layer code */
  aiaCode: AIALayerCode;
  /** Human-readable label */
  label: string;
  /** Default visibility */
  visible: boolean;
  /** Default line weight for layer */
  defaultWeight: LineWeight;
  /** Layer color (CSS color string) */
  color: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENHANCED DRAWING OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Drawing context with relationships for architectural generation
 */
export interface DrawingContext {
  /** Relationship data for openings */
  relationships?: {
    voids: VoidRelationship[];
    fills: FillRelationship[];
  };
  /** Entity metadata (bounding boxes, properties) */
  entityMetadata?: Map<number, EntityMetadata>;
}

/**
 * Metadata for an IFC entity
 */
export interface EntityMetadata {
  /** IFC type name */
  ifcType: string;
  /** 3D bounding box */
  bounds?: {
    min: Vec3;
    max: Vec3;
  };
  /** Property set values (for door operation, etc.) */
  properties?: Record<string, unknown>;
}

/**
 * Enhanced 2D drawing with architectural features
 */
export interface ArchitecturalDrawing2D extends Drawing2D {
  /** Architectural symbols (door swings, etc.) */
  symbols: ArchitecturalSymbol[];
  /** Layer definitions */
  layers: LayerDefinition[];
  /** Lines with architectural styling */
  architecturalLines: ArchitecturalLine[];
  /** Opening relationships used */
  openings: OpeningInfo[];
}
