/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hidden Line Classifier - Determine visibility of lines via depth testing
 *
 * Uses software rasterization to build a depth buffer, then classifies
 * each line segment as visible, hidden, or partially visible.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3, Point2D, Line2D, DrawingLine, Bounds2D, VisibilityState } from './types.js';
import {
  vec3,
  point2DLerp,
  point2DDistance,
  boundsEmpty,
  boundsExtendPoint,
  EPSILON,
} from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface VisibilitySegment {
  start: Point2D;
  end: Point2D;
  visible: boolean;
}

export interface VisibilityResult {
  line: DrawingLine;
  segments: VisibilitySegment[];
  overallVisibility: VisibilityState;
}

export interface HiddenLineOptions {
  /** Resolution of depth buffer (pixels on longest axis) */
  resolution: number;
  /** Number of samples along each line for visibility testing */
  samplesPerLine: number;
  /** Depth bias to avoid z-fighting */
  depthBias: number;
}

const DEFAULT_OPTIONS: HiddenLineOptions = {
  resolution: 1024,
  samplesPerLine: 10,
  depthBias: 0.001,
};

// ═══════════════════════════════════════════════════════════════════════════
// HIDDEN LINE CLASSIFIER
// ═══════════════════════════════════════════════════════════════════════════

export class HiddenLineClassifier {
  private options: HiddenLineOptions;

  private depthBuffer: Float32Array | null = null;
  private width: number = 0;
  private height: number = 0;
  private bounds: Bounds2D | null = null;

  constructor(options: Partial<HiddenLineOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Build depth buffer from projected triangles
   *
   * @param meshes Source meshes
   * @param axis Section axis
   * @param sectionPosition Position along axis
   * @param maxDepth Maximum depth to render
   * @param flipped Whether view is flipped
   * @param bounds Optional pre-computed 2D bounds
   */
  buildDepthBuffer(
    meshes: MeshData[],
    axis: 'x' | 'y' | 'z',
    sectionPosition: number,
    maxDepth: number,
    flipped: boolean,
    bounds?: Bounds2D
  ): void {
    // Compute bounds if not provided
    if (!bounds) {
      bounds = this.computeBounds(meshes, axis, sectionPosition, maxDepth, flipped);
    }
    this.bounds = bounds;

    // Calculate buffer dimensions
    const boundsWidth = bounds.max.x - bounds.min.x;
    const boundsHeight = bounds.max.y - bounds.min.y;

    if (boundsWidth < EPSILON || boundsHeight < EPSILON) {
      this.width = 1;
      this.height = 1;
      this.depthBuffer = new Float32Array([Infinity]);
      return;
    }

    const aspect = boundsWidth / boundsHeight;
    if (aspect > 1) {
      this.width = this.options.resolution;
      this.height = Math.max(1, Math.floor(this.options.resolution / aspect));
    } else {
      this.height = this.options.resolution;
      this.width = Math.max(1, Math.floor(this.options.resolution * aspect));
    }

    // Initialize depth buffer with infinity (far)
    this.depthBuffer = new Float32Array(this.width * this.height);
    this.depthBuffer.fill(Infinity);

    // Rasterize all triangles
    for (const mesh of meshes) {
      this.rasterizeMesh(mesh, axis, sectionPosition, maxDepth, flipped);
    }
  }

  /**
   * Classify lines as visible or hidden based on depth buffer
   */
  classifyLines(lines: DrawingLine[]): VisibilityResult[] {
    if (!this.depthBuffer || !this.bounds) {
      throw new Error('Depth buffer not built. Call buildDepthBuffer first.');
    }

    const results: VisibilityResult[] = [];

    for (const line of lines) {
      const result = this.classifySingleLine(line);
      results.push(result);
    }

    return results;
  }

  /**
   * Update lines with visibility classification
   * Returns new array with visibility set
   */
  applyVisibility(lines: DrawingLine[]): DrawingLine[] {
    const results = this.classifyLines(lines);

    const output: DrawingLine[] = [];

    for (const result of results) {
      if (result.overallVisibility === 'visible') {
        output.push({ ...result.line, visibility: 'visible' });
      } else if (result.overallVisibility === 'hidden') {
        output.push({ ...result.line, visibility: 'hidden' });
      } else {
        // Partial visibility - split into segments
        for (const seg of result.segments) {
          output.push({
            ...result.line,
            line: { start: seg.start, end: seg.end },
            visibility: seg.visible ? 'visible' : 'hidden',
          });
        }
      }
    }

    return output;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private computeBounds(
    meshes: MeshData[],
    axis: 'x' | 'y' | 'z',
    sectionPosition: number,
    maxDepth: number,
    flipped: boolean
  ): Bounds2D {
    let bounds = boundsEmpty();
    const axes = this.getProjectionAxes(axis);

    for (const mesh of meshes) {
      const { positions } = mesh;
      const vertexCount = positions.length / 3;

      for (let i = 0; i < vertexCount; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        const v = { x, y, z };

        // Check if vertex is in depth range
        const depth = v[axis] - sectionPosition;
        const inRange = flipped
          ? depth <= 0 && depth >= -maxDepth
          : depth >= 0 && depth <= maxDepth;

        if (inRange) {
          const u = v[axes.u];
          const vCoord = v[axes.v];
          const point2d = { x: flipped ? -u : u, y: vCoord };
          bounds = boundsExtendPoint(bounds, point2d);
        }
      }
    }

    // Add small margin
    const margin = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y) * 0.01;
    bounds.min.x -= margin;
    bounds.min.y -= margin;
    bounds.max.x += margin;
    bounds.max.y += margin;

    return bounds;
  }

  private getProjectionAxes(axis: 'x' | 'y' | 'z'): { u: 'x' | 'y' | 'z'; v: 'x' | 'y' | 'z' } {
    switch (axis) {
      case 'x':
        return { u: 'z', v: 'y' };
      case 'y':
        return { u: 'x', v: 'z' };
      case 'z':
        return { u: 'x', v: 'y' };
    }
  }

  private rasterizeMesh(
    mesh: MeshData,
    axis: 'x' | 'y' | 'z',
    sectionPosition: number,
    maxDepth: number,
    flipped: boolean
  ): void {
    const { positions, indices } = mesh;
    const axes = this.getProjectionAxes(axis);
    const triangleCount = indices.length / 3;

    for (let t = 0; t < triangleCount; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      // Get 3D vertices
      const v0 = this.getVertex(positions, i0);
      const v1 = this.getVertex(positions, i1);
      const v2 = this.getVertex(positions, i2);

      // Check if triangle is in depth range
      const d0 = v0[axis] - sectionPosition;
      const d1 = v1[axis] - sectionPosition;
      const d2 = v2[axis] - sectionPosition;

      const inRange = (d: number) =>
        flipped ? d <= 0 && d >= -maxDepth : d >= 0 && d <= maxDepth;

      // Skip triangles entirely outside depth range
      if (!inRange(d0) && !inRange(d1) && !inRange(d2)) {
        continue;
      }

      // Project to 2D + depth
      const p0 = this.projectVertex(v0, axes, flipped);
      const p1 = this.projectVertex(v1, axes, flipped);
      const p2 = this.projectVertex(v2, axes, flipped);

      // Rasterize triangle
      this.rasterizeTriangle(p0, p1, p2);
    }
  }

  private getVertex(positions: Float32Array, index: number): Vec3 {
    const base = index * 3;
    return vec3(positions[base], positions[base + 1], positions[base + 2]);
  }

  private projectVertex(
    v: Vec3,
    axes: { u: 'x' | 'y' | 'z'; v: 'x' | 'y' | 'z' },
    flipped: boolean
  ): { x: number; y: number; depth: number } {
    const u = v[axes.u];
    const vCoord = v[axes.v];
    // Find depth axis: the one not used for u or v projection
    const allAxes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
    const depthAxis = allAxes.find(a => a !== axes.u && a !== axes.v) ?? 'z';
    return {
      x: flipped ? -u : u,
      y: vCoord,
      depth: v[depthAxis],
    };
  }

  private rasterizeTriangle(
    p0: { x: number; y: number; depth: number },
    p1: { x: number; y: number; depth: number },
    p2: { x: number; y: number; depth: number }
  ): void {
    if (!this.bounds || !this.depthBuffer) return;

    // Convert to pixel coordinates
    const toPixelX = (x: number) =>
      ((x - this.bounds!.min.x) / (this.bounds!.max.x - this.bounds!.min.x)) * (this.width - 1);
    const toPixelY = (y: number) =>
      ((y - this.bounds!.min.y) / (this.bounds!.max.y - this.bounds!.min.y)) * (this.height - 1);

    const px0 = { x: toPixelX(p0.x), y: toPixelY(p0.y), depth: p0.depth };
    const px1 = { x: toPixelX(p1.x), y: toPixelY(p1.y), depth: p1.depth };
    const px2 = { x: toPixelX(p2.x), y: toPixelY(p2.y), depth: p2.depth };

    // Compute bounding box
    const minX = Math.max(0, Math.floor(Math.min(px0.x, px1.x, px2.x)));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(px0.x, px1.x, px2.x)));
    const minY = Math.max(0, Math.floor(Math.min(px0.y, px1.y, px2.y)));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(px0.y, px1.y, px2.y)));

    // Rasterize using barycentric coordinates
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const bary = this.barycentricCoords(px + 0.5, py + 0.5, px0, px1, px2);

        if (bary.u >= 0 && bary.v >= 0 && bary.w >= 0) {
          // Interpolate depth
          const depth = bary.u * px0.depth + bary.v * px1.depth + bary.w * px2.depth;

          const idx = py * this.width + px;
          if (depth < this.depthBuffer[idx]) {
            this.depthBuffer[idx] = depth;
          }
        }
      }
    }
  }

  private barycentricCoords(
    px: number,
    py: number,
    p0: { x: number; y: number },
    p1: { x: number; y: number },
    p2: { x: number; y: number }
  ): { u: number; v: number; w: number } {
    const v0x = p1.x - p0.x;
    const v0y = p1.y - p0.y;
    const v1x = p2.x - p0.x;
    const v1y = p2.y - p0.y;
    const v2x = px - p0.x;
    const v2y = py - p0.y;

    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;

    const denom = dot00 * dot11 - dot01 * dot01;
    // Handle degenerate triangles (zero area) by returning invalid coordinates
    if (Math.abs(denom) < 1e-10) {
      return { u: -1, v: -1, w: -1 };
    }
    const invDenom = 1 / denom;
    const v = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const w = (dot00 * dot12 - dot01 * dot02) * invDenom;
    const u = 1 - v - w;

    return { u, v, w };
  }

  private classifySingleLine(line: DrawingLine): VisibilityResult {
    if (!this.bounds || !this.depthBuffer) {
      return {
        line,
        segments: [{ start: line.line.start, end: line.line.end, visible: true }],
        overallVisibility: 'visible',
      };
    }

    const { samplesPerLine, depthBias } = this.options;
    const lineLength = point2DDistance(line.line.start, line.line.end);

    // For very short lines, just test the midpoint
    const numSamples = lineLength < EPSILON ? 1 : Math.max(2, samplesPerLine);

    const segments: VisibilitySegment[] = [];
    let currentStart = line.line.start;
    let currentVisible = this.sampleVisibility(line.line.start, line.depth, depthBias);
    let visibleCount = currentVisible ? 1 : 0;

    for (let i = 1; i <= numSamples; i++) {
      const t = i / numSamples;
      const point = point2DLerp(line.line.start, line.line.end, t);
      const isVisible = this.sampleVisibility(point, line.depth, depthBias);

      if (isVisible) visibleCount++;

      // Check for visibility change
      if (isVisible !== currentVisible && i < numSamples) {
        // Find transition point (approximate)
        const transitionT = (i - 0.5) / numSamples;
        const transitionPoint = point2DLerp(line.line.start, line.line.end, transitionT);

        segments.push({
          start: currentStart,
          end: transitionPoint,
          visible: currentVisible,
        });

        currentStart = transitionPoint;
        currentVisible = isVisible;
      }
    }

    // Final segment
    segments.push({
      start: currentStart,
      end: line.line.end,
      visible: currentVisible,
    });

    // Determine overall visibility
    let overallVisibility: VisibilityState;
    if (visibleCount === numSamples + 1) {
      overallVisibility = 'visible';
    } else if (visibleCount === 0) {
      overallVisibility = 'hidden';
    } else {
      overallVisibility = 'partial';
    }

    return { line, segments, overallVisibility };
  }

  private sampleVisibility(point: Point2D, lineDepth: number, depthBias: number): boolean {
    if (!this.bounds || !this.depthBuffer) return true;

    // Convert to pixel coordinates
    const px =
      ((point.x - this.bounds.min.x) / (this.bounds.max.x - this.bounds.min.x)) *
      (this.width - 1);
    const py =
      ((point.y - this.bounds.min.y) / (this.bounds.max.y - this.bounds.min.y)) *
      (this.height - 1);

    // Clamp to buffer bounds
    const ix = Math.max(0, Math.min(this.width - 1, Math.floor(px)));
    const iy = Math.max(0, Math.min(this.height - 1, Math.floor(py)));

    const bufferDepth = this.depthBuffer[iy * this.width + ix];

    // Line is visible if it's at or in front of the depth buffer
    return lineDepth <= bufferDepth + depthBias;
  }
}
