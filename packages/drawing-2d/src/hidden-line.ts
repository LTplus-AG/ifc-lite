/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hidden Line Classifier - Determine visibility of lines via depth testing
 *
 * Uses software rasterization (hidden-line-raster.ts) to build a min-depth
 * buffer of the KEPT half of the section, then classifies each line segment
 * as visible, hidden, or partially visible.
 *
 * # Depth convention (issue #2639, see projection-bands.ts)
 * Both the buffer and `DrawingLine.depth` / `depthEnd` carry the VIEW DEPTH
 * `-d` (the negated flip-adjusted signed depth): 0 at the cut plane,
 * increasing into the kept half, smaller means nearer the viewer. A line
 * sample is visible where `lineDepth <= bufferDepth + depthBias`.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Point2D, DrawingLine, Bounds2D, VisibilityState, SectionPlaneConfig } from './types.js';
import { point2DLerp, point2DDistance, EPSILON } from './math.js';
import { buildDepthRaster, type DepthRaster } from './hidden-line-raster.js';

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

  /** Null after build when no occluder rasterized: everything is visible. */
  private raster: DepthRaster | null = null;
  private built = false;

  constructor(options: Partial<HiddenLineOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Build the occluder depth buffer for the KEPT half of the section
   * (flip-adjusted depth in `[-occluderDepth, 0]`), storing view depths.
   *
   * Takes the FULL plane config (issue #2639): a custom (face-picked) plane
   * is honoured via the same `signedDepth` / `projectPointForPlane` helpers
   * the line producers use, so buffer and lines agree by construction. For
   * cardinal planes the projection is numerically identical to the old
   * axis/position/flipped path (same axis mapping, same `flipped ? -u : u`).
   *
   * @param meshes Source meshes (world = per-mesh origin + local positions)
   * @param plane Section plane (cardinal fields, plus optional customPlane)
   * @param occluderDepth How far into the kept half occluders rasterize
   * @param bounds Optional pre-computed 2D bounds
   */
  buildDepthBuffer(
    meshes: MeshData[],
    plane: SectionPlaneConfig,
    occluderDepth: number,
    bounds?: Bounds2D
  ): void {
    this.raster = buildDepthRaster(
      meshes,
      plane,
      occluderDepth,
      this.options.resolution,
      this.options.depthBias,
      bounds,
    );
    this.built = true;
  }

  /**
   * Classify lines as visible or hidden based on depth buffer
   */
  classifyLines(lines: DrawingLine[]): VisibilityResult[] {
    if (!this.built) {
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

  private classifySingleLine(line: DrawingLine): VisibilityResult {
    const { samplesPerLine, depthBias } = this.options;
    const lineLength = point2DDistance(line.line.start, line.line.end);

    // View depth varies along the line when the producer supplied a
    // per-endpoint `depthEnd` (e.g. a sloped edge); lerp it per sample.
    const depthStart = line.depth;
    const depthEnd = line.depthEnd ?? line.depth;
    const depthAt = (t: number) => depthStart + (depthEnd - depthStart) * t;

    // For very short lines, just test the midpoint
    const numSamples = lineLength < EPSILON ? 1 : Math.max(2, samplesPerLine);

    const segments: VisibilitySegment[] = [];
    let currentStart = line.line.start;
    let currentVisible = this.sampleVisibility(line.line.start, depthAt(0), depthBias);
    let visibleCount = currentVisible ? 1 : 0;

    for (let i = 1; i <= numSamples; i++) {
      const t = i / numSamples;
      const point = point2DLerp(line.line.start, line.line.end, t);
      const isVisible = this.sampleVisibility(point, depthAt(t), depthBias);

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
    const raster = this.raster;
    // No raster means no occluder rasterized into the kept half: nothing can
    // hide the line (issue #2639 - the previous code indexed the buffer with
    // NaN here and classified everything hidden).
    if (!raster) return true;

    const { bounds, width, height, buffer } = raster;

    // Convert to pixel coordinates
    const px = ((point.x - bounds.min.x) / (bounds.max.x - bounds.min.x)) * (width - 1);
    const py = ((point.y - bounds.min.y) / (bounds.max.y - bounds.min.y)) * (height - 1);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return true;

    // Clamp to buffer bounds
    const ix = Math.max(0, Math.min(width - 1, Math.floor(px)));
    const iy = Math.max(0, Math.min(height - 1, Math.floor(py)));

    const bufferDepth = buffer[iy * width + ix];

    // Line is visible if it's at or in front of the depth buffer
    return lineDepth <= bufferDepth + depthBias;
  }
}
