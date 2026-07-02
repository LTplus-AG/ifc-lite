/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry types for IFC-Lite
 */

/**
 * Mesh data for a single geometric representation of an IFC element.
 *
 * An element may produce MULTIPLE MeshData entries (one per material, CSG part,
 * or representation item). Group by `expressId` for per-element operations such
 * as DOM grouping, picking, or depth sorting. The number of meshes per element
 * depends on the IFC file's geometric complexity.
 */
export interface MeshData {
  expressId: number;
  ifcType?: string;          // IFC type name (e.g., "IfcWall", "IfcSpace") - optional for backward compatibility with old caches
  modelIndex?: number;       // Index of the model this mesh belongs to (for multi-model federation)
  positions: Float32Array;  // [x,y,z, x,y,z, ...]
  normals: Float32Array;    // [nx,ny,nz, ...]
  /** Triangle indices (3 per face).
   *  NOTE: Winding order is UNRELIABLE (meshes are double-sided by design).
   *  Do not use winding for front/back-face determination or normal-based
   *  culling. Use depth testing or `abs(dot(normal, viewDir))` for shading. */
  indices: Uint32Array;
  /** Apparent rendering colour: IfcSurfaceStyleRendering.DiffuseColour
   *  when authored, otherwise the SurfaceColour. Matches what most IFC
   *  viewers display and what the GLB exporter uses by default. */
  color: [number, number, number, number];
  /** SurfaceColour, populated by the WASM extractor only when the file
   *  authored a distinct DiffuseColour (so `shadingColor !== color`).
   *  Consumed by the GLB exporter's "Shading" colour-source option.
   *  For basic rendering, use `color` (matches most IFC viewers).
   *  For physically-accurate rendering, prefer `shadingColor ?? color`. */
  shadingColor?: [number, number, number, number];
  /** Per-vertex entity IDs for color-merged batches (desktop fast path).
   *  When present the renderer writes these instead of repeating `expressId`
   *  for every vertex, so picking/selection resolves to the correct individual
   *  entity even though many entities share a single GPU batch. */
  entityIds?: Uint32Array;
  /** Per-vertex texture coordinates (u, v pairs, 1:1 with positions), present
   *  only for textured meshes (issue #961). */
  uvs?: Float32Array;
  /** Decoded surface texture (IfcBlobTexture / IfcPixelTexture), present only
   *  for textured meshes (#961). Decoded to RGBA8 entirely in Rust; the
   *  renderer uploads `rgba` verbatim to a GPU texture. */
  texture?: MeshTexture;
  /** RTC-invariant per-entity geometry fingerprint from the WASM mesh pass,
   *  populated only when geometry hashing is enabled
   *  (`GeometryProcessor.enableGeometryHashes()`). All submeshes of one entity
   *  share the same value (it is the whole-entity hash). Consumed by the
   *  model-diff / compare feature (issue #924); renderers ignore it. */
  geometryHash?: bigint;
  /** Geometry provenance for rendering and the viewer's Model/Types view switch:
   *  - 0 = occurrence (placed IfcProduct). RENDER THIS in normal/Model views.
   *  - 1 = orphan type geometry (an IfcTypeProduct RepresentationMap with no
   *    occurrence). RENDER THIS in both Model and Types views.
   *  - 2 = instanced type template. DO NOT RENDER in normal/Model view.
   *    Instances of this type appear as class 0 occurrences with the same shape.
   *    Rendering class 2 produces duplicate overlapping geometry.
   *    Shown only in the viewer's Types mode.
   *
   *  Absent/undefined is treated as 0 (occurrence).
   *  Downstream filter: `if ((mesh.geometryClass ?? 0) === 2) continue;` */
  geometryClass?: number;
  /** Per-element local-frame origin (WebGL Y-up, metres): world position of
   *  vertex i = `origin + positions[3i..3i+3]`. Present when the wasm pipeline
   *  emits a per-element frame (building-scale f32 precision); absent/[0,0,0]
   *  means `positions` are already absolute world coords (legacy / native /
   *  caches predating local frame). The renderer reconstructs world via a
   *  per-batch model-matrix translate. */
  origin?: [number, number, number];
  /** Stable key for CPU caches that must distinguish *occurrences* sharing one
   *  `expressId`. GPU-instanced occurrences are materialized on demand as one
   *  MeshData per occurrence, all stamped with the same `expressId` but holding
   *  different world-space `positions` (issue #1405). Caches keyed on `expressId`
   *  alone (e.g. the measure-snap geometry cache) would collide across them and
   *  serve the first occurrence's geometry for every later one. When present,
   *  such caches must key on this instead. Absent for flat meshes (one MeshData
   *  per `expressId`), where `expressId` is already a sufficient key. */
  occurrenceKey?: string;
  /** Local (pre-placement, object-space) AABB — `positions` bounds as they
   *  were BEFORE the element's `IfcLocalPlacement` was baked in (issue #1474).
   *  Absent when not captured (e.g. an instancing template, or a mesh built
   *  outside the standard element pipeline). Unrelated to `origin`, which is
   *  a *world*-space translation captured AFTER placement, purely for f32
   *  precision — don't conflate the two. */
  localBounds?: { min: [number, number, number]; max: [number, number, number] };
  /** The resolved `IfcLocalPlacement` chain applied to this mesh (issue
   *  #1474): row-major 4x4, 16 numbers, WebGL Y-up metres (same frame as
   *  `positions`). Absent when not captured. All of one entity's `MeshData`
   *  pieces share the same value (one placement per element). */
  localToWorld?: number[];
}

/** A decoded RGBA8 surface texture attached to a mesh (issue #961). */
export interface MeshTexture {
  /** `width * height * 4` bytes, row-major, top-down, straight alpha. */
  rgba: Uint8Array;
  width: number;
  height: number;
  /** Sampler wrap from `IfcSurfaceTexture.RepeatS/RepeatT` (true = repeat). */
  repeatS: boolean;
  repeatT: boolean;
}

/**
 * Tessellation detail level for curved geometry (issue #976), mirroring the
 * Rust `ifc_lite_geometry::TessellationQuality` enum.
 *
 * `'medium'` is the engine default and reproduces the historical hardcoded
 * densities byte-for-byte — leaving the option unset never changes output.
 * Lower levels coarsen curved surfaces (swept pipes, cylinders, NURBS) and
 * profile circles for throughput / preview; higher levels refine curved
 * surfaces (×2 / ×4 segment density) to reduce visible faceting, at a
 * proportional triangle-count and processing cost. Profile-plane outlines
 * (extruded caps / opening cutters) never get finer than `'medium'` — denser
 * opening circles only multiply earcut cap-bridge slivers.
 */
export type TessellationQuality = 'lowest' | 'low' | 'medium' | 'high' | 'highest';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AABB {
  min: Vec3;
  max: Vec3;
}

/**
 * One resolved structural grid axis (`IfcGridAxis`), with its tag and the two
 * endpoints of its curve in the renderer's Y-up world frame (RTC-subtracted,
 * metres) — the same frame the streamed meshes render in, so grids overlay the
 * model by construction. See issue #945.
 */
export interface GridAxis {
  /** Express ID of the owning `IfcGrid`. */
  gridId: number;
  /** Express ID of the `IfcGridAxis`. */
  axisId: number;
  /** Axis tag (e.g. `"A"`, `"1"`); empty string when unauthored. */
  tag: string;
  /** Start endpoint `[x, y, z]` in renderer Y-up world space (metres). */
  start: [number, number, number];
  /** End endpoint `[x, y, z]` in renderer Y-up world space (metres). */
  end: [number, number, number];
}

export interface CoordinateInfo {
  originShift: Vec3;        // Shift applied to positions
  originalBounds: AABB;     // Bounds before shift
  shiftedBounds: AABB;      // Bounds after shift
  /** True if model had large coordinates requiring RTC shift. NOT the same as proper georeferencing via IfcMapConversion. */
  hasLargeCoordinates: boolean;
  /** RTC offset applied by WASM in IFC coordinates (Z-up). Used for multi-model alignment. */
  wasmRtcOffset?: Vec3;
  /** Building rotation angle in radians (from IfcSite placement). Rotation of building's principal axes relative to world X/Y/Z. */
  buildingRotation?: number;
  /**
   * Length-unit scale (file units → metres) from IfcProject's unit assignment,
   * e.g. `0.001` for millimetre files. Lets a consumer map externally-resolved
   * geometry (grids, survey points) into the render frame. See issue #945.
   */
  lengthUnitScale?: number;
}

/**
 * A point cloud attached to an IFC entity.
 *
 * Phase 0 carries a single inline `chunk`; future phases will add a
 * `source` reference for streaming sources (LAS/LAZ/Potree) and emit
 * multiple chunks per asset.
 *
 * Coordinates in `chunk.positions` are in the entity's local space (any
 * IFCx `usd::xformop` lineage transform has already been baked in by the
 * extractor). The renderer applies its own RTC + Y-up flip on upload.
 */
export interface PointCloudAsset {
  /** Express ID of the IFC entity that owns this scan. */
  expressId: number;
  /** IFC type name when known (`IfcPointCloud`, `IfcBuildingElementProxy`, ...). */
  ifcType?: string;
  /** Federation index — set when multiple models are loaded. */
  modelIndex?: number;
  /** A single chunk of decoded points (positions + optional rgb in 0..1). */
  chunk: {
    positions: Float32Array;
    /** Per-point RGB in 0..1; absent → renderer defaults to gray. */
    colors?: Float32Array;
    /** Per-point u8 LAS-style classification; absent → 0. */
    classifications?: Uint8Array;
    /** Per-point u16 intensity; absent → 0. */
    intensities?: Uint16Array;
    pointCount: number;
    bbox: { min: [number, number, number]; max: [number, number, number] };
  };
}

export interface GeometryResult {
  meshes: MeshData[];
  /**
   * Optional point clouds emitted alongside meshes. Renderers that don't
   * understand points are free to ignore this; the dedicated point pipeline
   * in `@ifc-lite/renderer` consumes it via `Renderer.addPointClouds()`.
   */
  pointClouds?: PointCloudAsset[];
  totalTriangles: number;
  totalVertices: number;
  coordinateInfo: CoordinateInfo;
  /**
   * Geometry-diff hashes (#924) for instanced-ONLY entities — repeated opaque
   * geometry whose whole mesh set went to the GPU-instanced shard, so it never
   * appears in `meshes`. Keyed by express id → hash. Lets the compare feature
   * detect geometry changes on instanced elements (it would otherwise silently
   * miss them, a regression vs. the pre-instancing flat path). Absent when
   * geometry hashing is off or no entity was fully instanced.
   */
  instancedGeometryHashes?: Map<number, bigint>;
}

// ═══════════════════════════════════════════════════════════════════════════
// SYMBOLIC REPRESENTATION TYPES
// For Plan, Annotation, FootPrint representations (2D curves for drawings)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Representation identifier types for symbolic representations
 */
export type SymbolicRepIdentifier = 'Plan' | 'Annotation' | 'FootPrint' | 'Axis';

/**
 * A 2D polyline from symbolic representations
 * Used for door swings, window cuts, equipment symbols, etc.
 */
export interface SymbolicPolyline {
  /** Express ID of the parent IFC element */
  expressId: number;
  /** IFC type name (e.g., "IfcDoor", "IfcWindow") */
  ifcType: string;
  /** 2D points as Float32Array [x1, y1, x2, y2, ...] */
  points: Float32Array;
  /** Number of points in the polyline */
  pointCount: number;
  /** Whether this is a closed loop */
  isClosed: boolean;
  /** Representation identifier ("Plan", "Annotation", etc.) */
  repIdentifier: string;
}

/**
 * A 2D circle or arc from symbolic representations
 */
export interface SymbolicCircle {
  /** Express ID of the parent IFC element */
  expressId: number;
  /** IFC type name */
  ifcType: string;
  /** Center X coordinate */
  centerX: number;
  /** Center Y coordinate */
  centerY: number;
  /** Radius */
  radius: number;
  /** Start angle in radians (0 for full circle) */
  startAngle: number;
  /** End angle in radians (2π for full circle) */
  endAngle: number;
  /** Whether this is a full circle */
  isFullCircle: boolean;
  /** Representation identifier */
  repIdentifier: string;
}

/**
 * Collection of symbolic representations from an IFC model
 * These are pre-authored 2D representations for architectural drawings
 */
export interface SymbolicRepresentationCollection {
  /** Number of polylines */
  polylineCount: number;
  /** Number of circles/arcs */
  circleCount: number;
  /** Total count of all symbolic items */
  totalCount: number;
  /** Check if collection is empty */
  isEmpty: boolean;
  /** Get polyline at index */
  getPolyline(index: number): SymbolicPolyline | undefined;
  /** Get circle at index */
  getCircle(index: number): SymbolicCircle | undefined;
  /** Get all express IDs that have symbolic representations */
  getExpressIds(): Uint32Array;
}

/**
 * Converted symbolic data for use in drawing generation
 * Organized by express ID for easy lookup
 */
export interface SymbolicDataByEntity {
  /** Map from expressId to polylines for that entity */
  polylines: Map<number, SymbolicPolyline[]>;
  /** Map from expressId to circles for that entity */
  circles: Map<number, SymbolicCircle[]>;
  /** Set of express IDs that have symbolic representations */
  expressIds: Set<number>;
}
