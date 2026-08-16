/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewport utility functions
 * Pure functions extracted from Viewport.tsx for reusability and testability
 */

import type { MeshData } from '@ifc-lite/geometry';

// ============================================================================
// Types
// ============================================================================

/**
 * 3D point/vector
 */
export interface Point3D {
  x: number;
  y: number;
  z: number;
}

/**
 * Bounding box in 3D space
 */
export interface BoundingBox3D {
  min: Point3D;
  max: Point3D;
}

/**
 * Section plane configuration
 */
export interface SectionPlaneConfig {
  enabled: boolean;
  height: number;
  min?: number;
  max?: number;
}

/**
 * Render options for the WebGPU renderer
 */
export interface RenderOptions {
  hiddenIds?: Set<number>;
  isolatedIds?: Set<number> | null;
  selectedId?: number | null;
  selectedIds?: Set<number>;
  clearColor?: [number, number, number, number];
  sectionPlane?: SectionPlaneConfig;
}

/**
 * Refs containing current visibility/selection state
 */
export interface ViewportStateRefs {
  hiddenEntities: Set<number>;
  isolatedEntities: Set<number> | null;
  selectedEntityId: number | null;
  clearColor: [number, number, number, number];
  activeTool: string;
  sectionPlane: { enabled: boolean; height: number };
  sectionRange: { min: number; max: number } | null;
}

// ============================================================================
// Entity Utilities
// ============================================================================

/**
 * Maximum coordinate threshold for valid geometry
 * Matches CoordinateHandler's NORMAL_COORD_THRESHOLD (10km)
 * Coordinates beyond this are likely corrupted or unshifted original coordinates
 */
const MAX_VALID_COORD = 10000;

/**
 * Check if a vertex coordinate is valid (finite and within reasonable bounds)
 */
function isValidCoord(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
    Math.abs(x) < MAX_VALID_COORD &&
    Math.abs(y) < MAX_VALID_COORD &&
    Math.abs(z) < MAX_VALID_COORD;
}

/**
 * Get bounding box for a specific entity from geometry
 * @param geometry - Array of mesh data
 * @param entityId - Express ID of the entity
 * @returns Bounding box or null if entity not found
 */
export function getEntityBounds(
  geometry: MeshData[] | null,
  entityId: number
): BoundingBox3D | null {
  if (!geometry) {
    return null;
  }

  // Find ALL meshes for this entity (entities can have multiple submeshes)
  const matchingMeshes = geometry.filter(
    (m) => m.expressId === entityId && m.positions.length >= 3
  );

  if (matchingMeshes.length === 0) {
    return null;
  }

  return boundsFromMeshes(matchingMeshes);
}

/**
 * Aggregate a bounding box across an entity's already-collected submeshes.
 * Shared by `getEntityBounds` (single id, one `.filter()` pass) and
 * `unionEntityBounds`'s indexed path (many ids, one shared index) — the
 * vertex-aggregation loop used to live only in `getEntityBounds`.
 */
function boundsFromMeshes(meshes: MeshData[]): BoundingBox3D | null {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  // Aggregate bounds across all submeshes
  // Filter out corrupted/unshifted vertices (> 10km from origin)
  for (const mesh of meshes) {
    // world = origin + position (per-element local frame; absent → absolute).
    const ox = mesh.origin ? mesh.origin[0] : 0;
    const oy = mesh.origin ? mesh.origin[1] : 0;
    const oz = mesh.origin ? mesh.origin[2] : 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] + ox;
      const y = mesh.positions[i + 1] + oy;
      const z = mesh.positions[i + 2] + oz;
      // Skip corrupted vertices (NaN, Inf, or huge coordinates from unshifted data)
      if (!isValidCoord(x, y, z)) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
  }

  // If no valid vertices found, return null
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return null;
  }

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

/**
 * Bucket a flat mesh list by `expressId`, keeping only the meshes
 * `getEntityBounds` would have kept (`positions.length >= 3`).
 *
 * One pass over the array, so a caller that needs bounds for many ids pays
 * O(meshes + N) instead of the O(N x meshes) of one `getEntityBounds` filter
 * per id.
 */
export function indexMeshesByEntity(geometry: MeshData[]): Map<number, MeshData[]> {
  const index = new Map<number, MeshData[]>();
  for (const mesh of geometry) {
    if (mesh.positions.length < 3) continue;
    const list = index.get(mesh.expressId);
    if (list) list.push(mesh);
    else index.set(mesh.expressId, [mesh]);
  }
  return index;
}

/**
 * The indexed equivalent of `getEntityBounds` — identical result, no scan.
 */
export function boundsFromIndex(
  index: Map<number, MeshData[]>,
  entityId: number,
): BoundingBox3D | null {
  const meshes = index.get(entityId);
  return meshes ? boundsFromMeshes(meshes) : null;
}

/**
 * Number of unindexed lookups a `createEntityBoundsLookup` reader gets before
 * it switches to the shared index. A handful of ids (a row click, a clash
 * pair) is cheaper to answer with one `.filter()` pass each than by building a
 * Map over the whole mesh array; past that the unindexed cost dominates.
 */
const INDEX_AFTER_LOOKUPS = 4;

/**
 * A bounds reader over a flat mesh list that indexes itself once the caller
 * asks about more than a handful of ids.
 *
 * Every reader returns exactly what `getEntityBounds(geometry, id)` returns —
 * the index is a lookup strategy, not a different answer. Use this instead of
 * calling `getEntityBounds` in a loop: an unindexed loop over N ids is
 * O(N x meshes), which on a large isolate/frame set (the Filter tab's
 * "Isolate in 3D" #2532, or an assembly whose parts are resolved one by one)
 * stalls the main thread for seconds.
 *
 * Does NOT memoise per id — that stays the caller's job, since callers that
 * also need the renderer's instanced-occurrence fallback must cache the
 * combined answer, not this one.
 *
 * @param geometry flat mesh list, or null once streaming released it
 * @param expectedLookups how many ids the caller already knows it will ask
 *   about, when it knows up front (`unionEntityBounds` has the id array).
 *   Above the threshold the index is built on the FIRST lookup rather than
 *   after a few unindexed ones. Callers that discover ids as they go (the
 *   viewport's aggregation expansion, where one assembly id can turn into
 *   hundreds of parts) omit it and let the reader index itself.
 */
export function createEntityBoundsLookup(
  geometry: MeshData[] | null,
  expectedLookups?: number,
): (entityId: number) => BoundingBox3D | null {
  const indexUpFront = (expectedLookups ?? 0) > INDEX_AFTER_LOOKUPS;
  let index: Map<number, MeshData[]> | null = null;
  let lookups = 0;
  return (entityId: number) => {
    if (!geometry) return null;
    if (!index && (indexUpFront || ++lookups > INDEX_AFTER_LOOKUPS)) {
      index = indexMeshesByEntity(geometry);
    }
    return index ? boundsFromIndex(index, entityId) : getEntityBounds(geometry, entityId);
  };
}

/**
 * Get center point of an entity's bounding box
 * @param geometry - Array of mesh data
 * @param entityId - Express ID of the entity
 * @returns Center point or null if entity not found
 */
export function getEntityCenter(
  geometry: MeshData[] | null,
  entityId: number
): Point3D | null {
  const bounds = getEntityBounds(geometry, entityId);
  if (!bounds) {
    return null;
  }

  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
}

/**
 * Calculate combined bounding box from multiple meshes
 * @param meshes - Array of mesh data
 * @returns Combined bounding box
 */
export function calculateGeometryBounds(meshes: MeshData[]): BoundingBox3D {
  if (meshes.length === 0) {
    return {
      min: { x: -100, y: -100, z: -100 },
      max: { x: 100, y: 100, z: 100 },
    };
  }

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  // Filter out corrupted/unshifted vertices (> 10km from origin)
  for (const mesh of meshes) {
    // world = origin + position (per-element local frame; absent → absolute).
    const ox = mesh.origin ? mesh.origin[0] : 0;
    const oy = mesh.origin ? mesh.origin[1] : 0;
    const oz = mesh.origin ? mesh.origin[2] : 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] + ox;
      const y = mesh.positions[i + 1] + oy;
      const z = mesh.positions[i + 2] + oz;
      // Skip corrupted vertices (NaN, Inf, or huge coordinates from unshifted data)
      if (!isValidCoord(x, y, z)) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
  }

  // Handle degenerate cases:
  // - Non-finite values (no valid positions found)
  // - All three axes degenerate (single point)
  // Note: Planar/linear geometry (only 1-2 axes equal) is valid and should NOT fall back
  const isNonFinite = !Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ) ||
                      !Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(maxZ);
  const isFullyDegenerate = minX === maxX && minY === maxY && minZ === maxZ;

  if (isNonFinite || isFullyDegenerate) {
    return {
      min: { x: -100, y: -100, z: -100 },
      max: { x: 100, y: 100, z: 100 },
    };
  }

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

/**
 * Accumulate a world-space AABB over the meshes whose `ifcType` is NOT in
 * `excludeTypes` (case-sensitive IfcPascalCase). Returns `null` when no valid
 * vertex contributes, so the caller can merge with other sources (e.g.
 * instanced-occurrence bounds) and decide a fallback. Used to frame the
 * building shell while skipping the IfcSite/terrain extent and IfcSpace.
 */
export function accumulateBoundsExcludingTypes(
  meshes: MeshData[],
  excludeTypes: ReadonlySet<string>,
): BoundingBox3D | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;

  for (const mesh of meshes) {
    if (mesh.ifcType && excludeTypes.has(mesh.ifcType)) continue;
    const ox = mesh.origin ? mesh.origin[0] : 0;
    const oy = mesh.origin ? mesh.origin[1] : 0;
    const oz = mesh.origin ? mesh.origin[2] : 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] + ox;
      const y = mesh.positions[i + 1] + oy;
      const z = mesh.positions[i + 2] + oz;
      if (!isValidCoord(x, y, z)) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      any = true;
    }
  }

  if (!any || !Number.isFinite(minX)) return null;
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

// ============================================================================
// Render Options Builder
// ============================================================================

/**
 * Build render options from viewport state refs
 * Reduces code duplication - this object is constructed ~15+ times in Viewport.tsx
 *
 * @param refs - Object containing current state values from refs
 * @returns Render options for the WebGPU renderer
 */
export function buildRenderOptions(refs: ViewportStateRefs): RenderOptions {
  const options: RenderOptions = {
    hiddenIds: refs.hiddenEntities,
    isolatedIds: refs.isolatedEntities,
    selectedId: refs.selectedEntityId,
    clearColor: refs.clearColor,
  };

  // Add section plane if enabled
  if (refs.activeTool === 'section') {
    options.sectionPlane = {
      ...refs.sectionPlane,
      min: refs.sectionRange?.min,
      max: refs.sectionRange?.max,
    };
  }

  return options;
}

/**
 * Build render options with additional selectedIds for multi-selection
 */
export function buildRenderOptionsWithSelection(
  refs: ViewportStateRefs,
  selectedIds?: Set<number>
): RenderOptions {
  const options = buildRenderOptions(refs);
  if (selectedIds) {
    options.selectedIds = selectedIds;
  }
  return options;
}

// ============================================================================
// Throttling Utilities
// ============================================================================

/**
 * Get render throttle interval based on mesh count
 * Adaptive throttling: faster for small models, slower for large models
 *
 * @param meshCount - Number of meshes in the scene
 * @returns Throttle interval in milliseconds
 */
export function getRenderThrottleMs(meshCount: number): number {
  if (meshCount < 10000) {
    return 16; // ~60fps for small models
  } else if (meshCount < 50000) {
    return 25; // ~40fps for medium models
  } else {
    return 33; // ~30fps for large models
  }
}

// ============================================================================
// Theme Utilities
// ============================================================================

/**
 * Get clear color based on theme
 * @param theme - 'light', 'dark', or 'colorful'
 * @returns RGBA clear color tuple
 */
export function getThemeClearColor(theme: 'light' | 'dark' | 'colorful'): [number, number, number, number] {
  if (theme === 'light') {
    return [0.96, 0.96, 0.97, 1]; // Light gray
  }
  if (theme === 'colorful') {
    // Transparent — the CSS gradient on the canvas element shows through.
    // alphaMode:'premultiplied' + fragment alpha=1 keeps models fully opaque.
    return [0, 0, 0, 0];
  }
  return [0.102, 0.106, 0.149, 1]; // Tokyo Night storm (#1a1b26)
}

// ============================================================================
// Scale Calculation
// ============================================================================

/**
 * Calculate world-space size for a scale bar
 *
 * @param viewportHeight - Canvas height in pixels
 * @param cameraDistance - Camera distance from target
 * @param fov - Field of view in radians
 * @param scaleBarPixels - Scale bar width in pixels (default 96px = 6rem)
 * @returns World-space size represented by the scale bar
 */
export function calculateScaleBarSize(
  viewportHeight: number,
  cameraDistance: number,
  fov: number,
  scaleBarPixels: number = 96
): number {
  return (scaleBarPixels / viewportHeight) * (cameraDistance * Math.tan(fov / 2) * 2);
}

/**
 * Union the world AABBs of `ids`, taking each entity's bounds from the flat mesh
 * list first and falling back to the renderer's per-occurrence AABB.
 *
 * The fallback exists because GPU-instanced occurrences are not in
 * `geometryResult.meshes` at all — and, critically, because `geometry` can be
 * `null` on its own: once streaming releases the mesh arrays, the renderer's
 * scene is the ONLY source of bounds left. Callers must therefore not short-circuit
 * on a null `geometry`; `getEntityBounds(null, id)` already returns null and lets
 * each id fall through to `instancedBounds`.
 *
 * @param geometry flat mesh list, or null once released
 * @param ids federated GLOBAL ids (single model: global === express)
 * @param instancedBounds per-occurrence AABB from the renderer scene
 * @returns the union, or null when no id resolved to bounds
 */
export function unionEntityBounds(
  geometry: MeshData[] | null,
  ids: number[],
  instancedBounds: (id: number) => BoundingBox3D | null | undefined,
): { min: Point3D; max: Point3D } | null {
  let min: Point3D | null = null;
  let max: Point3D | null = null;

  // Self-indexing reader: past a handful of ids it buckets the mesh array by
  // expressId ONCE rather than re-filtering the whole array per id, so this
  // loop is O(meshes + N) instead of O(N × meshes). Shared with every other
  // many-id bounds path (see `createEntityBoundsLookup`).
  const meshBounds = createEntityBoundsLookup(geometry, ids.length);

  for (const id of ids) {
    const b = meshBounds(id) ?? instancedBounds(id) ?? null;
    if (!b) continue;
    if (!min || !max) {
      min = { x: b.min.x, y: b.min.y, z: b.min.z };
      max = { x: b.max.x, y: b.max.y, z: b.max.z };
    } else {
      min.x = Math.min(min.x, b.min.x);
      min.y = Math.min(min.y, b.min.y);
      min.z = Math.min(min.z, b.min.z);
      max.x = Math.max(max.x, b.max.x);
      max.y = Math.max(max.y, b.max.y);
      max.z = Math.max(max.z, b.max.z);
    }
  }
  return min && max ? { min, max } : null;
}
