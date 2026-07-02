/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Local parsing utility functions
 * Pure functions for geometry processing, bounds calculation, and batch management
 *
 * Extracted from useIfc.ts for reusability and testability
 */

import type { MeshData } from '@ifc-lite/geometry';

// ============================================================================
// Types
// ============================================================================

/**
 * Bounding box for 3D geometry
 */
export interface Bounds3D {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Coordinate information for geometry
 */
export interface CoordinateInfo {
  originShift: { x: number; y: number; z: number };
  originalBounds: Bounds3D;
  shiftedBounds: Bounds3D;
  /** True if model had large coordinates requiring RTC shift. NOT the same as proper georeferencing via IfcMapConversion. */
  hasLargeCoordinates: boolean;
}

/**
 * Geometry statistics
 */
export interface GeometryStats {
  totalVertices: number;
  totalTriangles: number;
}

// ============================================================================
// Bounds Calculation
// ============================================================================

/**
 * Maximum coordinate threshold for valid geometry (10km)
 * Matches CoordinateHandler's NORMAL_COORD_THRESHOLD
 * Coordinates beyond this are likely corrupted or unshifted original coordinates
 */
export const MAX_VALID_COORD = 10000;

/**
 * Create an initial bounds object with infinite values
 * Use this as a starting point for incremental bounds calculation
 */
export function createEmptyBounds(): Bounds3D {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
}

/**
 * Update bounds incrementally from a mesh's positions
 * Mutates the bounds object for performance
 *
 * @param bounds - Bounds object to update (mutated)
 * @param positions - Float32Array of vertex positions (x,y,z triplets)
 * @param maxCoord - Maximum valid coordinate value (default: 10km)
 */
export function updateBoundsFromPositions(
  bounds: Bounds3D,
  positions: Float32Array | number[],
  maxCoord: number = MAX_VALID_COORD,
  origin?: [number, number, number] | null,
): void {
  // `origin` is the element's local-frame origin (world = origin + position).
  // When present (per-element local frame, or a translated GLB import) the
  // corruption filter still applies to the *local* coordinate — small by
  // construction — but the bound is taken in WORLD space, so a legitimately
  // large georeferenced offset (~1e6 m) doesn't fold the camera onto the scene
  // origin (the `coordinateInfo.shiftedBounds` fallback in useGeometryStreaming
  // uses these bounds when no robust box is selected). Absent origin →
  // world == local, byte-identical to the legacy non-local-frame behaviour.
  const ox = origin ? origin[0] : 0;
  const oy = origin ? origin[1] : 0;
  const oz = origin ? origin[2] : 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    // Filter out corrupted/unshifted vertices (> threshold from the LOCAL origin).
    const isValid = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
      Math.abs(x) < maxCoord && Math.abs(y) < maxCoord && Math.abs(z) < maxCoord;
    if (isValid) {
      const wx = x + ox, wy = y + oy, wz = z + oz;
      bounds.min.x = Math.min(bounds.min.x, wx);
      bounds.min.y = Math.min(bounds.min.y, wy);
      bounds.min.z = Math.min(bounds.min.z, wz);
      bounds.max.x = Math.max(bounds.max.x, wx);
      bounds.max.y = Math.max(bounds.max.y, wy);
      bounds.max.z = Math.max(bounds.max.z, wz);
    }
  }
}

/**
 * Calculate bounds from an array of meshes
 *
 * @param meshes - Array of mesh data
 * @returns Bounds and geometry statistics
 */
export function calculateMeshBounds(meshes: MeshData[]): { bounds: Bounds3D; stats: GeometryStats } {
  const bounds = createEmptyBounds();
  let totalVertices = 0;
  let totalTriangles = 0;

  for (const mesh of meshes) {
    // Fold the per-element local-frame origin so the bounds are world-space
    // (a translated GLB import keeps positions local + origin on the placement).
    updateBoundsFromPositions(bounds, mesh.positions, MAX_VALID_COORD, mesh.origin ?? null);
    totalVertices += mesh.positions.length / 3;
    totalTriangles += mesh.indices.length / 3;
  }

  return {
    bounds,
    stats: { totalVertices, totalTriangles },
  };
}

/**
 * Create coordinate info from bounds
 *
 * @param bounds - Calculated geometry bounds
 * @param originShift - Optional origin shift (defaults to zero)
 * @param hasLargeCoordinates - Whether model had large coordinates requiring RTC shift
 * @returns Coordinate info object with cloned bounds and computed shiftedBounds
 */
export function createCoordinateInfo(
  bounds: Bounds3D,
  originShift: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  hasLargeCoordinates: boolean = false
): CoordinateInfo {
  // Deep-clone the incoming bounds into originalBounds
  const originalBounds: Bounds3D = {
    min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
    max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
  };

  // Compute shiftedBounds by subtracting originShift from each min/max
  const shiftedBounds: Bounds3D = {
    min: {
      x: bounds.min.x - originShift.x,
      y: bounds.min.y - originShift.y,
      z: bounds.min.z - originShift.z,
    },
    max: {
      x: bounds.max.x - originShift.x,
      y: bounds.max.y - originShift.y,
      z: bounds.max.z - originShift.z,
    },
  };

  return {
    originShift: { x: originShift.x, y: originShift.y, z: originShift.z },
    originalBounds,
    shiftedBounds,
    hasLargeCoordinates,
  };
}

// ============================================================================
// Render Throttling
// ============================================================================

/**
 * Calculate render interval based on file size
 * Adaptive throttling: smaller files get more frequent updates, larger files fewer
 *
 * @param fileSizeMB - File size in megabytes
 * @returns Render interval in milliseconds
 */
export function getRenderIntervalMs(fileSizeMB: number): number {
  if (fileSizeMB > 300) {
    return 500;  // Very large files: 2 updates/sec (fewer GPU fragment creations)
  } else if (fileSizeMB > 100) {
    return 200;  // Huge files: 5 updates/sec
  } else if (fileSizeMB > 50) {
    return 100;  // Large files: 10 updates/sec
  } else if (fileSizeMB > 20) {
    return 75;   // Medium files: ~13 updates/sec
  }
  return 50;     // Small files: 20 updates/sec
}

/**
 * Calculate server streaming render interval
 *
 * @param fileSizeMB - File size in megabytes
 * @returns Render interval in milliseconds
 */
export function getServerStreamIntervalMs(fileSizeMB: number): number {
  return fileSizeMB > 100 ? 200 : 100;
}

// ============================================================================
// Storey Height Calculation
// ============================================================================

/**
 * Calculate storey heights from elevation differences
 * When property data doesn't provide heights, we can infer them from
 * the difference between consecutive storey elevations
 *
 * @param storeyElevations - Map of storey ID to elevation
 * @returns Map of storey ID to calculated height
 */
export function calculateStoreyHeights(storeyElevations: Map<number, number>): Map<number, number> {
  const heights = new Map<number, number>();

  if (storeyElevations.size < 2) {
    return heights;
  }

  const entries = Array.from(storeyElevations.entries()) as Array<[number, number]>;
  const sortedStoreys = entries.sort((a, b) => a[1] - b[1]); // Sort by elevation ascending

  for (let i = 0; i < sortedStoreys.length - 1; i++) {
    const [storeyId, elevation] = sortedStoreys[i];
    const nextElevation = sortedStoreys[i + 1][1];
    const height = nextElevation - elevation;
    if (height > 0) {
      heights.set(storeyId, height);
    }
  }

  return heights;
}

// ============================================================================
// Progress Calculation
// ============================================================================

/**
 * Calculate progress percentage for geometry streaming
 *
 * @param currentMeshes - Number of meshes processed so far
 * @param estimatedTotal - Estimated total meshes (may be 0 or inaccurate)
 * @param basePercent - Base percentage (start of geometry phase)
 * @param maxPercent - Maximum percentage to reach
 * @returns Progress percentage
 */
export function calculateStreamingProgress(
  currentMeshes: number,
  estimatedTotal: number,
  basePercent: number = 50,
  maxPercent: number = 95
): number {
  const denominator = Math.max(estimatedTotal / 10, currentMeshes);
  // Guard against division by zero (both currentMeshes and estimatedTotal are 0)
  if (denominator === 0) {
    return basePercent;
  }
  const progressRange = maxPercent - basePercent;
  return Math.min(maxPercent, basePercent + (currentMeshes / denominator) * progressRange);
}

// ============================================================================
// Mesh Conversion
// ============================================================================

/**
 * Normalize IFCX mesh color to RGBA format
 *
 * @param color - Optional color array (RGB or RGBA)
 * @returns Normalized RGBA color tuple
 */
export function normalizeColor(
  color?: [number, number, number, number] | [number, number, number] | number[]
): [number, number, number, number] {
  // Return default color if no color provided or array is too short
  if (!color || color.length < 3) {
    return [0.7, 0.7, 0.7, 1.0];
  }
  if (color.length === 4) {
    return color as [number, number, number, number];
  }
  return [color[0], color[1], color[2], 1.0];
}

/**
 * Convert server mesh colors from float [0-1] to byte [0-255]
 *
 * @param floatColors - Float color array [0-1]
 * @returns Uint8Array of byte colors [0-255]
 */
export function convertFloatColorToBytes(floatColors: number[]): Uint8Array {
  return new Uint8Array(floatColors.map((c: number) => Math.round(c * 255)));
}
