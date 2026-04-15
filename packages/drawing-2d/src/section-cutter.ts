/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section Cutter - Core algorithm for cutting 3D triangle meshes with a plane
 *
 * Generates 2D line segments and reconstructed polygons for architectural drawings.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type {
  Vec3,
  Point2D,
  SectionPlaneConfig,
  CutSegment,
  MeshCutResult,
  SectionCutResult,
  DrawingPolygon,
  EntityKey,
} from './types.js';
import { makeEntityKey } from './types.js';
import {
  vec3,
  vec3Lerp,
  EPSILON,
  getAxisNormal,
  signedDistanceToPlane,
  projectTo2D,
} from './math.js';
import { PolygonBuilder } from './polygon-builder.js';

// ═══════════════════════════════════════════════════════════════════════════
// SECTION CUTTER CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class SectionCutter {
  private planeNormal: Vec3;
  private planeDistance: number;
  private axis: 'x' | 'y' | 'z';
  private flipped: boolean;

  constructor(config: SectionPlaneConfig) {
    this.axis = config.axis;
    this.flipped = config.flipped;
    this.planeNormal = getAxisNormal(config.axis, config.flipped);
    this.planeDistance = config.position;
  }

  /**
   * Cut all meshes with the section plane
   */
  cutMeshes(meshes: MeshData[]): SectionCutResult {
    const startTime = performance.now();

    const segmentArrays: CutSegment[][] = [];
    let totalTriangles = 0;
    let intersectedTriangles = 0;

    // Process each mesh - collect segment arrays for efficient flattening
    for (const mesh of meshes) {
      const result = this.cutSingleMesh(mesh);
      segmentArrays.push(result.segments);
      totalTriangles += result.trianglesProcessed;
      intersectedTriangles += result.trianglesIntersected;
    }

    // Flatten all segments at once (more efficient than repeated push(...spread))
    const allSegments = segmentArrays.flat();

    // Reconstruct closed polygons from segments
    const polygonBuilder = new PolygonBuilder();
    const polygons = polygonBuilder.buildPolygons(allSegments);

    const processingTimeMs = performance.now() - startTime;

    return {
      segments: allSegments,
      polygons,
      stats: {
        totalTriangles,
        intersectedTriangles,
        segmentCount: allSegments.length,
        polygonCount: polygons.length,
        processingTimeMs,
      },
    };
  }

  /**
   * Cut a single mesh with the section plane
   */
  cutSingleMesh(mesh: MeshData): MeshCutResult {
    const segments: CutSegment[] = [];
    const { positions, indices, expressId, ifcType, modelIndex } = mesh;

    const triangleCount = indices.length / 3;
    let intersectedCount = 0;

    for (let t = 0; t < triangleCount; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      // Get triangle vertices
      const v0 = this.getVertex(positions, i0);
      const v1 = this.getVertex(positions, i1);
      const v2 = this.getVertex(positions, i2);

      // Compute signed distances from plane
      const d0 = signedDistanceToPlane(v0, this.planeNormal, this.planeDistance);
      const d1 = signedDistanceToPlane(v1, this.planeNormal, this.planeDistance);
      const d2 = signedDistanceToPlane(v2, this.planeNormal, this.planeDistance);

      // Intersect triangle with plane
      const intersection = this.intersectTrianglePlane(v0, v1, v2, d0, d1, d2);

      if (intersection) {
        intersectedCount++;

        // Project 3D points to 2D
        const p0_2d = projectTo2D(intersection.p0, this.axis, this.flipped);
        const p1_2d = projectTo2D(intersection.p1, this.axis, this.flipped);

        // Skip degenerate segments
        const dx = p1_2d.x - p0_2d.x;
        const dy = p1_2d.y - p0_2d.y;
        if (dx * dx + dy * dy < EPSILON * EPSILON) {
          continue;
        }

        segments.push({
          p0: intersection.p0,
          p1: intersection.p1,
          p0_2d,
          p1_2d,
          entityId: expressId,
          ifcType: ifcType || 'Unknown',
          modelIndex: modelIndex || 0,
        });
      }
    }

    return {
      segments,
      trianglesProcessed: triangleCount,
      trianglesIntersected: intersectedCount,
    };
  }

  /**
   * Get vertex from positions array
   */
  private getVertex(positions: Float32Array, index: number): Vec3 {
    const base = index * 3;
    return vec3(positions[base], positions[base + 1], positions[base + 2]);
  }

  /**
   * Intersect a triangle with the section plane
   * Returns the two intersection points, or null if no intersection
   */
  private intersectTrianglePlane(
    v0: Vec3,
    v1: Vec3,
    v2: Vec3,
    d0: number,
    d1: number,
    d2: number
  ): { p0: Vec3; p1: Vec3 } | null {
    // Count vertices on each side of the plane
    const pos =
      (d0 > EPSILON ? 1 : 0) + (d1 > EPSILON ? 1 : 0) + (d2 > EPSILON ? 1 : 0);
    const neg =
      (d0 < -EPSILON ? 1 : 0) + (d1 < -EPSILON ? 1 : 0) + (d2 < -EPSILON ? 1 : 0);

    // No intersection if all vertices on same side
    if (pos === 3 || neg === 3) return null;

    // All vertices on the plane - skip (degenerate case)
    if (pos === 0 && neg === 0) return null;

    // Find intersection points on edges
    const points: Vec3[] = [];

    // Check edge v0-v1
    const p01 = this.edgePlaneIntersection(v0, v1, d0, d1);
    if (p01) points.push(p01);

    // Check edge v1-v2
    const p12 = this.edgePlaneIntersection(v1, v2, d1, d2);
    if (p12) points.push(p12);

    // Check edge v2-v0
    if (points.length < 2) {
      const p20 = this.edgePlaneIntersection(v2, v0, d2, d0);
      if (p20) points.push(p20);
    }

    // Need exactly 2 intersection points
    if (points.length >= 2) {
      return { p0: points[0], p1: points[1] };
    }

    return null;
  }

  /**
   * Find intersection point of an edge with the plane
   */
  private edgePlaneIntersection(
    v0: Vec3,
    v1: Vec3,
    d0: number,
    d1: number
  ): Vec3 | null {
    // Both vertices on the plane - edge lies on plane
    if (Math.abs(d0) < EPSILON && Math.abs(d1) < EPSILON) {
      return null; // Handled separately as face-on-plane
    }

    // One vertex on plane - return that vertex
    if (Math.abs(d0) < EPSILON) return v0;
    if (Math.abs(d1) < EPSILON) return v1;

    // Both vertices on same side - no intersection
    if ((d0 > 0) === (d1 > 0)) return null;

    // Compute interpolation parameter
    const t = d0 / (d0 - d1);

    // Interpolate to find intersection point
    return vec3Lerp(v0, v1, t);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STREAMING SECTION CUTTER (for large models)
// ═══════════════════════════════════════════════════════════════════════════

export interface StreamingSectionCutterOptions {
  /** Callback when a batch of segments is ready */
  onSegments?: (segments: CutSegment[], progress: number) => void;
  /** Batch size for streaming (number of meshes per batch) */
  batchSize?: number;
  /** Yield to event loop every N milliseconds */
  yieldIntervalMs?: number;
}

/**
 * Streaming section cutter for large models
 * Processes meshes in batches to avoid blocking the main thread
 */
export async function cutMeshesStreaming(
  meshes: MeshData[],
  config: SectionPlaneConfig,
  options: StreamingSectionCutterOptions = {}
): Promise<SectionCutResult> {
  const { onSegments, batchSize = 100, yieldIntervalMs = 16 } = options;

  const cutter = new SectionCutter(config);
  const startTime = performance.now();

  const allSegmentArrays: CutSegment[][] = [];
  let totalTriangles = 0;
  let intersectedTriangles = 0;
  let lastYield = performance.now();

  for (let i = 0; i < meshes.length; i += batchSize) {
    const batch = meshes.slice(i, Math.min(i + batchSize, meshes.length));
    const batchSegmentArrays: CutSegment[][] = [];

    for (const mesh of batch) {
      const result = cutter.cutSingleMesh(mesh);
      batchSegmentArrays.push(result.segments);
      totalTriangles += result.trianglesProcessed;
      intersectedTriangles += result.trianglesIntersected;
    }

    // Flatten batch for progress callback
    const batchSegments = batchSegmentArrays.flat();
    allSegmentArrays.push(batchSegments);

    // Report progress
    const progress = Math.min(1, (i + batch.length) / meshes.length);
    onSegments?.(batchSegments, progress);

    // Yield to event loop periodically
    const now = performance.now();
    if (now - lastYield > yieldIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }

  // Flatten all segments at once (more efficient than repeated push(...spread))
  const allSegments = allSegmentArrays.flat();

  // Build polygons from all segments
  const polygonBuilder = new PolygonBuilder();
  const polygons = polygonBuilder.buildPolygons(allSegments);

  const processingTimeMs = performance.now() - startTime;

  return {
    segments: allSegments,
    polygons,
    stats: {
      totalTriangles,
      intersectedTriangles,
      segmentCount: allSegments.length,
      polygonCount: polygons.length,
      processingTimeMs,
    },
  };
}
