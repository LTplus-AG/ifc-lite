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

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  // Aggregate bounds across all submeshes
  // Filter out corrupted/unshifted vertices (> 10km from origin)
  for (const mesh of matchingMeshes) {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i];
      const y = mesh.positions[i + 1];
      const z = mesh.positions[i + 2];
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
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i];
      const y = mesh.positions[i + 1];
      const z = mesh.positions[i + 2];
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
