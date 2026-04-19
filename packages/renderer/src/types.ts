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
 * Instanced geometry for GPU instancing
 * Groups identical geometries with different transforms
 */
export interface InstancedMesh {
  geometryId: number;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  instanceBuffer: GPUBuffer; // Storage buffer with instance data
  instanceCount: number;
  // Map expressId to instance index for picking
  expressIdToInstanceIndex: Map<number, number>;
  // Cached bind group for instanced rendering (avoids per-frame allocation)
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
  // Bounding box for frustum culling (optional)
  bounds?: { min: [number, number, number]; max: [number, number, number] };
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
  enableDepthTest?: boolean;
  enableFrustumCulling?: boolean;
  spatialIndex?: import('@ifc-lite/spatial').SpatialIndex;
  // Visibility filtering
  hiddenIds?: Set<number>;        // Meshes to hide
  isolatedIds?: Set<number> | null; // Only show these meshes (null = show all)
  selectedId?: number | null;     // Currently selected mesh (for highlighting)
  selectedIds?: Set<number>;      // Multi-selection support
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
  // When true, skips the post-processing pass (contact shading / separation lines)
  // for faster frame times during rapid camera movement (zoom, orbit, pan).
  // The post-processing is restored automatically on the next non-interacting frame.
  isInteracting?: boolean;
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
}
