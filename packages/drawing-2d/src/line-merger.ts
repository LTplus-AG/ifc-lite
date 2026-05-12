/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Line Merger - Merges collinear line segments into longer lines
 *
 * Reduces the number of line segments in the output by combining
 * segments that lie on the same line and are connected or overlapping.
 */

import type { Point2D, Line2D, DrawingLine, EntityKey } from './types.js';
import { makeEntityKey } from './types.js';
import {
  EPSILON,
  point2DDistance,
  point2DSub,
  point2DDot,
  point2DCross,
  point2DNormalize,
  lineDirection,
  projectPointOnLine,
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
  const mergedLine2Ds = mergeCollinearLines(line2Ds, opts);

  // Map merged lines back to DrawingLines
  // Use properties from first line in group (they're all the same)
  const template = lines[0];

  return mergedLine2Ds.map((line) => ({
    ...template,
    line,
  }));
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

  // Group lines by direction (using angle buckets)
  const buckets = groupByDirection(lines, opts.angleTolerance);

  const result: Line2D[] = [];

  // Process each direction bucket
  for (const bucket of buckets.values()) {
    // Further group by actual line (same direction, same line equation)
    const lineGroups = groupByLine(bucket, opts.distanceTolerance);

    for (const group of lineGroups) {
      // Merge segments on the same line
      const merged = mergeSegmentsOnLine(group, opts.gapTolerance);
      result.push(...merged);
    }
  }

  return result;
}

/**
 * Group lines by their direction (angle bucket)
 */
function groupByDirection(
  lines: Line2D[],
  angleTolerance: number
): Map<number, Line2D[]> {
  const buckets = new Map<number, Line2D[]>();
  const bucketSize = angleTolerance * 2;

  for (const line of lines) {
    const dir = lineDirection(line);
    // Normalize angle to [0, π) since direction is symmetric
    let angle = Math.atan2(dir.y, dir.x);
    if (angle < 0) angle += Math.PI;
    if (angle >= Math.PI) angle -= Math.PI;

    // Find bucket
    const bucketIdx = Math.floor(angle / bucketSize);

    if (!buckets.has(bucketIdx)) {
      buckets.set(bucketIdx, []);
    }
    buckets.get(bucketIdx)!.push(line);
  }

  return buckets;
}

/**
 * Group lines that lie on the same infinite line
 */
function groupByLine(lines: Line2D[], distanceTolerance: number): Line2D[][] {
  const groups: Line2D[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (assigned.has(i)) continue;

    const group: Line2D[] = [lines[i]];
    assigned.add(i);

    // Find all other lines on the same line
    for (let j = i + 1; j < lines.length; j++) {
      if (assigned.has(j)) continue;

      if (linesOnSameLine(lines[i], lines[j], distanceTolerance)) {
        group.push(lines[j]);
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
 * Merge segments that lie on the same line
 * Uses 1D projection along the line
 */
function mergeSegmentsOnLine(lines: Line2D[], gapTolerance: number): Line2D[] {
  if (lines.length <= 1) return lines;

  // Project all segments to 1D parameter space along the line
  const baseLine = lines[0];
  const dir = lineDirection(baseLine);
  const origin = baseLine.start;

  // Represent each segment as [t0, t1] interval
  interface Interval {
    t0: number;
    t1: number;
  }

  const intervals: Interval[] = lines.map((line) => {
    const t0 = projectPoint1D(line.start, origin, dir);
    const t1 = projectPoint1D(line.end, origin, dir);
    return { t0: Math.min(t0, t1), t1: Math.max(t0, t1) };
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
      // Merge
      current = {
        t0: current.t0,
        t1: Math.max(current.t1, next.t1),
      };
    } else {
      // Gap too large, start new interval
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  // Convert back to Line2D
  return merged.map((interval) => ({
    start: {
      x: origin.x + dir.x * interval.t0,
      y: origin.y + dir.y * interval.t0,
    },
    end: {
      x: origin.x + dir.x * interval.t1,
      y: origin.y + dir.y * interval.t1,
    },
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
