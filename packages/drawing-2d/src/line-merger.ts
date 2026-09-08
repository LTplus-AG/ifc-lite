/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Line Merger - Merges collinear line segments into longer lines
 *
 * Reduces the number of line segments in the output by combining
 * segments that lie on the same line and are connected or overlapping.
 */

import type { Point2D, Line2D, DrawingLine } from './types.js';
import {
  EPSILON,
  point2DDistance,
  point2DSub,
  point2DDot,
  point2DCross,
  lineDirection,
} from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// LINE MERGER
// ═══════════════════════════════════════════════════════════════════════════

export interface LineMergerOptions {
  /** Angle tolerance for considering lines collinear (radians) */
  angleTolerance: number;
  /** Distance tolerance for considering lines on same line */
  distanceTolerance: number;
  /** Gap tolerance for merging non-touching collinear segments */
  gapTolerance: number;
}

const DEFAULT_OPTIONS: LineMergerOptions = {
  angleTolerance: 0.01, // ~0.5 degrees
  distanceTolerance: 0.001,
  gapTolerance: 0.01,
};

/**
 * Merge collinear line segments within the same entity
 */
export function mergeDrawingLines(
  lines: DrawingLine[],
  options: Partial<LineMergerOptions> = {}
): DrawingLine[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Group lines by entity and category
  const groups = new Map<string, DrawingLine[]>();

  for (const line of lines) {
    const key = `${line.modelIndex}:${line.entityId}:${line.category}:${line.visibility}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(line);
  }

  // Merge within each group
  const result: DrawingLine[] = [];

  for (const groupLines of groups.values()) {
    const merged = mergeLineGroup(groupLines, opts);
    result.push(...merged);
  }

  return result;
}

/**
 * Merge lines within a single group (same entity, category, visibility)
 */
function mergeLineGroup(lines: DrawingLine[], opts: LineMergerOptions): DrawingLine[] {
  if (lines.length <= 1) return lines;

  // Extract just the Line2D parts for merging
  const line2Ds = lines.map((l) => l.line);
  const mergedSegments = mergeCollinearSegments(line2Ds, opts);

  // Map merged lines back to DrawingLines. The non-depth properties are
  // uniform across the group (the grouping key covers model, entity,
  // category and visibility, and ifcType follows the entity), so any line
  // can donate them. `depth`/`depthEnd` are NOT uniform: since #2639 they
  // carry per-endpoint view depth, so each merged endpoint takes the depth
  // of the exact source endpoint it came from (mergeSegmentsOnLine tracks
  // that provenance) — including a swap when the contributing segment runs
  // against the merged line's direction.
  const template = lines[0];

  return mergedSegments.map((m) => {
    const depth = endpointDepth(lines[m.startSource.index], m.startSource.endpoint);
    const depthEnd = endpointDepth(lines[m.endSource.index], m.endSource.endpoint);
    const merged: DrawingLine = { ...template, line: m.line, depth };
    if (depthEnd !== depth) {
      merged.depthEnd = depthEnd;
    } else {
      // "Omitted means constant depth" — don't leak the template's depthEnd.
      delete merged.depthEnd;
    }
    return merged;
  });
}

/** View depth at one endpoint of a DrawingLine (absent depthEnd = constant). */
function endpointDepth(line: DrawingLine, endpoint: 'start' | 'end'): number {
  return endpoint === 'start' ? line.depth : line.depthEnd ?? line.depth;
}

/**
 * Core algorithm: merge collinear Line2D segments
 */
export function mergeCollinearLines(
  lines: Line2D[],
  options: Partial<LineMergerOptions> = {}
): Line2D[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (lines.length <= 1) return lines;
  return mergeCollinearSegments(lines, opts).map((m) => m.line);
}

/** Which endpoint of which input segment produced a merged endpoint. */
interface EndpointRef {
  /** Index into the input `lines` array */
  index: number;
  /** Which endpoint of that segment */
  endpoint: 'start' | 'end';
}

/** A merged segment plus the provenance of its two endpoints. */
interface MergedSegment {
  line: Line2D;
  startSource: EndpointRef;
  endSource: EndpointRef;
}

/**
 * Merge collinear segments, tracking which source endpoint became each
 * merged endpoint so callers can carry endpoint metadata (view depth) over.
 */
function mergeCollinearSegments(lines: Line2D[], opts: LineMergerOptions): MergedSegment[] {
  // Group lines by direction (using angle buckets)
  const buckets = groupByDirection(lines, opts.angleTolerance);

  const result: MergedSegment[] = [];

  // Process each direction bucket
  for (const bucket of buckets.values()) {
    // Further group by actual line (same direction, same line equation)
    const lineGroups = groupByLine(lines, bucket, opts.distanceTolerance);

    for (const group of lineGroups) {
      // Merge segments on the same line
      result.push(...mergeSegmentsOnLine(lines, group, opts.gapTolerance));
    }
  }

  return result;
}

/**
 * Group line indices by their direction (angle bucket)
 */
function groupByDirection(
  lines: Line2D[],
  angleTolerance: number
): Map<number, number[]> {
  const buckets = new Map<number, number[]>();
  const bucketSize = angleTolerance * 2;

  for (let i = 0; i < lines.length; i++) {
    const dir = lineDirection(lines[i]);
    // Normalize angle to [0, π) since direction is symmetric
    let angle = Math.atan2(dir.y, dir.x);
    if (angle < 0) angle += Math.PI;
    if (angle >= Math.PI) angle -= Math.PI;

    // Find bucket
    const bucketIdx = Math.floor(angle / bucketSize);

    if (!buckets.has(bucketIdx)) {
      buckets.set(bucketIdx, []);
    }
    buckets.get(bucketIdx)!.push(i);
  }

  return buckets;
}

/**
 * Group line indices whose lines lie on the same infinite line
 */
function groupByLine(
  lines: Line2D[],
  indices: number[],
  distanceTolerance: number
): number[][] {
  const groups: number[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < indices.length; i++) {
    if (assigned.has(i)) continue;

    const group: number[] = [indices[i]];
    assigned.add(i);

    // Find all other lines on the same line
    for (let j = i + 1; j < indices.length; j++) {
      if (assigned.has(j)) continue;

      if (linesOnSameLine(lines[indices[i]], lines[indices[j]], distanceTolerance)) {
        group.push(indices[j]);
        assigned.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}

/**
 * Check if two lines lie on the same infinite line
 */
function linesOnSameLine(a: Line2D, b: Line2D, tolerance: number): boolean {
  const dirA = lineDirection(a);

  // Distance from b.start to line a
  const toB = point2DSub(b.start, a.start);
  const distStart = Math.abs(point2DCross(dirA, toB));

  if (distStart > tolerance) return false;

  // Distance from b.end to line a
  const toBEnd = point2DSub(b.end, a.start);
  const distEnd = Math.abs(point2DCross(dirA, toBEnd));

  return distEnd <= tolerance;
}

/**
 * Merge segments (given by index into `lines`) that lie on the same line.
 * Uses 1D projection along the line. Each merged endpoint is, by
 * construction, the projection of some SOURCE endpoint (intervals are the
 * min/max of endpoint parameters and merging keeps the extremes), so the
 * returned provenance is exact — no interpolation is involved.
 */
function mergeSegmentsOnLine(
  lines: Line2D[],
  indices: number[],
  gapTolerance: number
): MergedSegment[] {
  // Project all segments to 1D parameter space along the line
  const baseLine = lines[indices[0]];
  const dir = lineDirection(baseLine);
  const origin = baseLine.start;

  // Represent each segment as [t0, t1] interval, remembering which source
  // endpoint sits at each side (a segment running against `dir` swaps them).
  interface Interval {
    t0: number;
    t1: number;
    s0: EndpointRef;
    s1: EndpointRef;
  }

  const intervals: Interval[] = indices.map((index) => {
    const line = lines[index];
    const tStart = projectPoint1D(line.start, origin, dir);
    const tEnd = projectPoint1D(line.end, origin, dir);
    if (tStart <= tEnd) {
      return {
        t0: tStart,
        t1: tEnd,
        s0: { index, endpoint: 'start' as const },
        s1: { index, endpoint: 'end' as const },
      };
    }
    return {
      t0: tEnd,
      t1: tStart,
      s0: { index, endpoint: 'end' as const },
      s1: { index, endpoint: 'start' as const },
    };
  });

  // Sort by start parameter
  intervals.sort((a, b) => a.t0 - b.t0);

  // Merge overlapping/adjacent intervals
  const merged: Interval[] = [];
  let current = intervals[0];

  for (let i = 1; i < intervals.length; i++) {
    const next = intervals[i];

    // Check if intervals overlap or are adjacent (within gap tolerance)
    if (next.t0 <= current.t1 + gapTolerance) {
      // Merge; the far endpoint (and its provenance) moves only when the
      // next interval actually extends past the current one.
      if (next.t1 > current.t1) {
        current = { t0: current.t0, s0: current.s0, t1: next.t1, s1: next.s1 };
      }
    } else {
      // Gap too large, start new interval
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  // Convert back to Line2D, keeping endpoint provenance
  return merged.map((interval) => ({
    line: {
      start: {
        x: origin.x + dir.x * interval.t0,
        y: origin.y + dir.y * interval.t0,
      },
      end: {
        x: origin.x + dir.x * interval.t1,
        y: origin.y + dir.y * interval.t1,
      },
    },
    startSource: interval.s0,
    endSource: interval.s1,
  }));
}

/**
 * Project point to 1D parameter along direction from origin
 */
function projectPoint1D(point: Point2D, origin: Point2D, dir: Point2D): number {
  const toPoint = point2DSub(point, origin);
  return point2DDot(toPoint, dir);
}

// ═══════════════════════════════════════════════════════════════════════════
// SEGMENT DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Remove duplicate line segments
 */
export function deduplicateLines(
  lines: Line2D[],
  tolerance: number = 0.001
): Line2D[] {
  const result: Line2D[] = [];

  for (const line of lines) {
    let isDuplicate = false;

    for (const existing of result) {
      if (linesEqual(line, existing, tolerance)) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      result.push(line);
    }
  }

  return result;
}

/**
 * Check if two lines are equal (considering both directions)
 */
function linesEqual(a: Line2D, b: Line2D, tolerance: number): boolean {
  // Forward match
  if (
    point2DDistance(a.start, b.start) < tolerance &&
    point2DDistance(a.end, b.end) < tolerance
  ) {
    return true;
  }

  // Reverse match
  if (
    point2DDistance(a.start, b.end) < tolerance &&
    point2DDistance(a.end, b.start) < tolerance
  ) {
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// LINE SPLITTING (for hidden line removal)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split a line at given parameters
 * @param line The line to split
 * @param params Array of t values (0-1) where to split
 * @returns Array of line segments
 */
export function splitLineAtParams(line: Line2D, params: number[]): Line2D[] {
  // Add endpoints and sort
  const allParams = [0, ...params.filter((t) => t > 0 && t < 1), 1].sort(
    (a, b) => a - b
  );

  // Remove duplicates
  const uniqueParams: number[] = [];
  for (const p of allParams) {
    if (uniqueParams.length === 0 || p - uniqueParams[uniqueParams.length - 1] > EPSILON) {
      uniqueParams.push(p);
    }
  }

  // Create segments
  const segments: Line2D[] = [];
  for (let i = 0; i < uniqueParams.length - 1; i++) {
    const t0 = uniqueParams[i];
    const t1 = uniqueParams[i + 1];

    segments.push({
      start: {
        x: line.start.x + t0 * (line.end.x - line.start.x),
        y: line.start.y + t0 * (line.end.y - line.start.y),
      },
      end: {
        x: line.start.x + t1 * (line.end.x - line.start.x),
        y: line.start.y + t1 * (line.end.y - line.start.y),
      },
    });
  }

  return segments;
}
