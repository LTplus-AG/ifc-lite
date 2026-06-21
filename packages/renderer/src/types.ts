/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renderer types for IFC-Lite
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Mat4 {
  m: Float32Array; // 16 elements, column-major
}

export interface Camera {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fov: number;
  aspect: number;
  near: number;
  far: number;
}

export interface Material {
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  transparency?: number;
}

export interface Mesh {
  expressId: number;
  modelIndex?: number;  // Index of the model this mesh belongs to (for multi-model federation)
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  transform: Mat4;
  color: [number, number, number, number];
  material?: Material;
  // Per-mesh GPU resources for unique colors
  uniformBuffer?: GPUBuffer;
  bindGroup?: GPUBindGroup;
  // Bounding box for frustum culling (optional)
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Batched mesh - groups multiple meshes with same color into single draw call
 * Reduces draw calls from N meshes to ~100-500 batches
 *
 * When a single color group's geometry would exceed the GPU's maxBufferSize
 * limit, the data is automatically split across multiple buckets at
 * accumulation time. Each bucket gets a unique colorKey (base key or
 * "base#N"), so the rest of the pipeline stays unchanged.
 */
export interface BatchedMesh {
  id: number;        // Unique monotonic identifier for this batch instance
  colorKey: string;  // Unique batch key (base color hash, or "hash#N" for overflow buckets)
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  color: [number, number, number, number];
  expressIds: number[];  // For picking - all expressIds in this batch
  bindGroup?: GPUBindGroup;
  uniformBuffer?: GPUBuffer;
  // Bounding box for frustum culling (optional) — WORLD space.
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  /** Per-batch local-frame origin: stored vertex positions are RELATIVE to it,
   *  so this batch must be drawn with model = translate(origin) to land in world
   *  space (world = origin + position). Keeps f32 vertex coords element-small at
   *  building/georef scale (no fan collapse). [0,0,0] = absolute (legacy). */
  origin?: [number, number, number];
  /** True when every source mesh in this batch is a material-layer slice
   *  (geometryClass 3). Those slices are watertight, outward-wound thin solids
   *  whose interior coincident caps z-fight when drawn double-sided; the draw
   *  loop renders this batch with the BACKFACE-CULLING pipeline so only the
   *  visible build-up surfaces rasterise (clean solid, no hollow shimmer). */
  isLayer?: boolean;
}

// Section plane for clipping
// Semantic axis names: down (Y), front (Z), side (X) for intuitive user experience
export type SectionPlaneAxis = 'down' | 'front' | 'side';

export type SectionCapHatchId =
  | 'solid'
  | 'diagonal'
  | 'crossHatch'
  | 'horizontal'
  | 'vertical'
  | 'concrete'
  | 'brick'
  | 'insulation';

export interface SectionCapStyleOptions {
  /** Fill colour behind the hatch. RGBA 0-1. */
  fillColor?: [number, number, number, number];
  /** Hatch stroke colour. RGBA 0-1. */
  strokeColor?: [number, number, number, number];
  /** Hatch pattern id. */
  pattern?: SectionCapHatchId;
  /** Spacing between hatch lines, in screen pixels. */
  spacingPx?: number;
  /** Primary angle in radians. */
  angleRad?: number;
  /** Line width in pixels. */
  widthPx?: number;
  /** Secondary angle (cross-hatch). */
  secondaryAngleRad?: number;
}

export interface SectionPlane {
  axis: SectionPlaneAxis;
  position: number; // 0-100 percentage of model bounds
  enabled: boolean;
  flipped?: boolean; // If true, show the opposite side of the cut
  min?: number;      // Optional override for min range value
  max?: number;      // Optional override for max range value
  /** If true (default), render filled cap surfaces with a screen-space hatch. */
  showCap?: boolean;
  /**
   * If true (default), draw polygon outlines on the cut surfaces. Users
   * can turn surfaces and outlines on/off independently from the UI.
   */
  showOutlines?: boolean;
  /** Override the default cap appearance. */
  capStyle?: SectionCapStyleOptions;
  /**
   * Optional world-space plane normal (unit vector). When provided
   * together with `distance`, the shader clip uses them verbatim and
   * ignores `axis`, `position`, `min`, `max`, and any `buildingRotation`.
   * Used for face-pick / arbitrary slice planes (issue #243).
   */
  normal?: [number, number, number];
  /** Plane offset in world units: `dot(pointOnPlane, normal)`. */
  distance?: number;
}

export type ContactShadingQuality = 'off' | 'low' | 'high';
export type SeparationLinesQuality = 'off' | 'low' | 'high';

export interface VisualEnhancementOptions {
  enabled?: boolean;
  edgeContrast?: {
    enabled?: boolean;
    intensity?: number;
  };
  contactShading?: {
    quality?: ContactShadingQuality;
    intensity?: number;
    radius?: number;
  };
  separationLines?: {
    enabled?: boolean;
    quality?: SeparationLinesQuality;
    intensity?: number;
    radius?: number;
  };
}

export interface RenderOptions {
  clearColor?: [number, number, number, number];
  /**
   * Global lighting environment (sun direction/colour, hemisphere ambient,
   * exposure, procedural sky). Omitted/empty reproduces the legacy hardcoded
   * look exactly. See {@link import('./environment.js').LightingEnvironment}.
   */
  environment?: import('./environment.js').LightingEnvironment;
  enableDepthTest?: boolean;
  enableFrustumCulling?: boolean;
  spatialIndex?: import('@ifc-lite/spatial').SpatialIndex;
  // Visibility filtering
  hiddenIds?: Set<number>;        // Meshes to hide
  isolatedIds?: Set<number> | null; // Only show these meshes (null = show all)
  selectedId?: number | null;     // Currently selected mesh (for highlighting)
  selectedIds?: Set<number>;      // Multi-selection support
  /**
   * Per-frame alpha overrides — primary use case is X-Ray mode.
   *
   * Map<expressId, alpha 0..1>. Non-selected meshes/batches whose expressId
   * appears in this map render at the override alpha through the transparent
   * pipeline. Selected meshes (`selectedId` / `selectedIds`) are exempt at
   * every site, so highlights always paint with their own alpha.
   *
   * Mixed batches (some entries overridden, some not) take the minimum
   * override alpha across non-selected ids; selected meshes in the batch
   * are then redrawn on top by the highlight pass.
   *
   * The renderer snapshots this map at frame start, so callers may freely
   * mutate or recycle their copy after `render()` returns.
   *
   * Note: alphas `>= 0.99` are treated as opaque (the cutoff for switching to
   * the transparent pipeline). Entries at or above that threshold are no-ops
   * — keep them out of the map to avoid unnecessary work.
   */
  transparencyOverrides?: Map<number, number> | null;
  /**
   * X-Ray *context* mode: every non-selected mesh whose `expressId` is NOT in
   * this set renders at {@link ghostAlpha}, so a focused subset (e.g. a clash
   * pair) stays solid while the rest of the model fades to translucent context.
   *
   * `null`/absent disables ghosting. Selected meshes (`selectedId`/`selectedIds`)
   * are always exempt, and explicit {@link transparencyOverrides} entries win
   * over the ghost alpha. Same id space as `isolatedIds` (federated global id).
   *
   * Mixed colour batches resolve to the minimum alpha among their non-selected
   * entities (same as {@link transparencyOverrides}), so an excepted id that
   * shares a batch with ghosted ids fades with the batch unless it is also in
   * `selectedIds` — the selection highlight pass then repaints it opaque. To
   * guarantee a focused entity stays fully solid, include it in `selectedIds`
   * (the clash viewer co-selects the focused pair for exactly this reason).
   */
  ghostExceptIds?: Set<number> | null;
  /** Alpha (0..1) for ghosted meshes under {@link ghostExceptIds}. Default 0.12. */
  ghostAlpha?: number;
  // Building rotation in radians (from IfcSite placement) - used to orient section planes
  buildingRotation?: number;
  selectedModelIndex?: number;    // Model index for multi-model selection (must match mesh.modelIndex)
  // Section plane clipping
  sectionPlane?: SectionPlane;
  // Terrain clipping: discard fragments below this Y value in viewer space.
  // Used by Cesium overlay to prevent model from showing below terrain.
  terrainClipY?: number;
  // Optional visual effects for better subelement readability
  visualEnhancement?: VisualEnhancementOptions;
  // Streaming state
  isStreaming?: boolean;          // If true, skip expensive operations like picker
  // True during rapid camera movement (zoom, orbit, pan, animations).
  // Post effects (contact shading / separation lines) KEEP RUNNING during
  // interaction as long as the measured frame cadence holds; on GPUs that
  // miss frames the renderer adaptively degrades to skipping the post pass
  // for the rest of the gesture (see InteractionEffectsGovernor). Full
  // quality is always restored on the next non-interacting frame.
  isInteracting?: boolean;
  // The app's own intentional cap on continuous render cadence in ms
  // (e.g. the large-model interaction throttle). When set, the effects
  // governor judges missed frames against this slower schedule instead of
  // the display refresh — a deliberately throttled 33ms cadence is not a
  // GPU miss.
  interactionFrameIntervalMs?: number;
}

/**
 * Options for GPU picking/selection
 * Filters out hidden/invisible elements so users can select what's visible
 */
export interface PickOptions {
  // Skip picking during streaming for performance
  isStreaming?: boolean;
  // Visibility filtering - same as RenderOptions for consistency
  hiddenIds?: Set<number>;        // Hidden elements (can't be picked)
  isolatedIds?: Set<number> | null; // Only these elements can be picked (null = all pickable)
}

/**
 * Result from GPU picking
 * For multi-model support, includes both expressId and modelIndex
 */
export interface PickResult {
  expressId: number;
  modelIndex?: number;  // Index of the model this entity belongs to
  /**
   * World-space XYZ of the picked surface point. Optional because the
   * pick path can skip depth readback for callers that only need the
   * entityId (e.g. selection state). Recovered by sampling the pick
   * pass's depth texture at the click position and unprojecting.
   */
  worldXYZ?: { x: number; y: number; z: number };
}
