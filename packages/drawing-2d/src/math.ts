/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Vector math utilities for 2D drawing generation
 */

import type { Vec2, Vec3, Point2D, Line2D, Bounds2D } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

export const EPSILON = 1e-7;

// ═══════════════════════════════════════════════════════════════════════════
// VEC3 OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vec3Scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len < EPSILON) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function vec3Lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + t * (b.x - a.x),
    y: a.y + t * (b.y - a.y),
    z: a.z + t * (b.z - a.z),
  };
}

export function vec3Equals(a: Vec3, b: Vec3, tolerance: number = EPSILON): boolean {
  return (
    Math.abs(a.x - b.x) < tolerance &&
    Math.abs(a.y - b.y) < tolerance &&
    Math.abs(a.z - b.z) < tolerance
  );
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ═══════════════════════════════════════════════════════════════════════════
// VEC2 / POINT2D OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

export function point2D(x: number, y: number): Point2D {
  return { x, y };
}

export function point2DAdd(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function point2DSub(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function point2DScale(p: Point2D, s: number): Point2D {
  return { x: p.x * s, y: p.y * s };
}

export function point2DDot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

export function point2DLength(p: Point2D): number {
  return Math.sqrt(p.x * p.x + p.y * p.y);
}

export function point2DDistance(a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function point2DLerp(a: Point2D, b: Point2D, t: number): Point2D {
  return {
    x: a.x + t * (b.x - a.x),
    y: a.y + t * (b.y - a.y),
  };
}

export function point2DEquals(a: Point2D, b: Point2D, tolerance: number = EPSILON): boolean {
  return Math.abs(a.x - b.x) < tolerance && Math.abs(a.y - b.y) < tolerance;
}

export function point2DNormalize(p: Point2D): Point2D {
  const len = point2DLength(p);
  if (len < EPSILON) return { x: 0, y: 0 };
  return { x: p.x / len, y: p.y / len };
}

/**
 * 2D cross product (returns scalar z-component)
 */
export function point2DCross(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x;
}

// ═══════════════════════════════════════════════════════════════════════════
// LINE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

export function lineLength(line: Line2D): number {
  return point2DDistance(line.start, line.end);
}

export function lineMidpoint(line: Line2D): Point2D {
  return {
    x: (line.start.x + line.end.x) / 2,
    y: (line.start.y + line.end.y) / 2,
  };
}

export function lineDirection(line: Line2D): Point2D {
  return point2DNormalize(point2DSub(line.end, line.start));
}

/**
 * Check if two lines are collinear (same direction and overlapping)
 */
export function linesCollinear(
  a: Line2D,
  b: Line2D,
  angleTolerance: number = 0.01,
  distanceTolerance: number = 0.001
): boolean {
  const dirA = lineDirection(a);
  const dirB = lineDirection(b);

  // Check if directions are parallel (or anti-parallel)
  const cross = Math.abs(point2DCross(dirA, dirB));
  if (cross > angleTolerance) return false;

  // Check if lines are on the same line (distance from point to line)
  const toB = point2DSub(b.start, a.start);
  const dist = Math.abs(point2DCross(dirA, toB));
  return dist < distanceTolerance;
}

/**
 * Project a point onto a line, returning the parameter t
 * t=0 at start, t=1 at end
 */
export function projectPointOnLine(point: Point2D, line: Line2D): number {
  const lineVec = point2DSub(line.end, line.start);
  const pointVec = point2DSub(point, line.start);
  const lenSq = point2DDot(lineVec, lineVec);
  if (lenSq < EPSILON) return 0;
  return point2DDot(pointVec, lineVec) / lenSq;
}

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDS OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

export function boundsEmpty(): Bounds2D {
  return {
    min: { x: Infinity, y: Infinity },
    max: { x: -Infinity, y: -Infinity },
  };
}

export function boundsExtendPoint(bounds: Bounds2D, point: Point2D): Bounds2D {
  return {
    min: {
      x: Math.min(bounds.min.x, point.x),
      y: Math.min(bounds.min.y, point.y),
    },
    max: {
      x: Math.max(bounds.max.x, point.x),
      y: Math.max(bounds.max.y, point.y),
    },
  };
}

export function boundsExtendLine(bounds: Bounds2D, line: Line2D): Bounds2D {
  let result = boundsExtendPoint(bounds, line.start);
  result = boundsExtendPoint(result, line.end);
  return result;
}

export function boundsCenter(bounds: Bounds2D): Point2D {
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
  };
}

export function boundsSize(bounds: Bounds2D): Point2D {
  return {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
  };
}

export function boundsValid(bounds: Bounds2D): boolean {
  return (
    bounds.min.x <= bounds.max.x &&
    bounds.min.y <= bounds.max.y &&
    isFinite(bounds.min.x) &&
    isFinite(bounds.max.x) &&
    isFinite(bounds.min.y) &&
    isFinite(bounds.max.y)
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PLANE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute signed distance from point to plane
 * Positive = in front of plane (in normal direction)
 * Negative = behind plane
 */
export function signedDistanceToPlane(point: Vec3, normal: Vec3, distance: number): number {
  return vec3Dot(point, normal) - distance;
}

/**
 * Get the normal vector for a section axis
 */
export function getAxisNormal(axis: 'x' | 'y' | 'z', flipped: boolean): Vec3 {
  const sign = flipped ? -1 : 1;
  switch (axis) {
    case 'x':
      return { x: sign, y: 0, z: 0 };
    case 'y':
      return { x: 0, y: sign, z: 0 };
    case 'z':
      return { x: 0, y: 0, z: sign };
  }
}

/**
 * Get the two axes perpendicular to the section axis (for 2D projection)
 */
export function getProjectionAxes(axis: 'x' | 'y' | 'z'): { u: 'x' | 'y' | 'z'; v: 'x' | 'y' | 'z' } {
  switch (axis) {
    case 'x':
      return { u: 'z', v: 'y' }; // Looking along X, project to ZY
    case 'y':
      return { u: 'x', v: 'z' }; // Looking along Y (down), project to XZ
    case 'z':
      return { u: 'x', v: 'y' }; // Looking along Z, project to XY
  }
}

/**
 * Project a 3D point to 2D based on section axis
 */
export function projectTo2D(point: Vec3, axis: 'x' | 'y' | 'z', flipped: boolean): Point2D {
  const axes = getProjectionAxes(axis);
  const u = point[axes.u];
  const v = point[axes.v];
  // Flip U axis when section is flipped to maintain consistent orientation
  return { x: flipped ? -u : u, y: v };
}

// ═══════════════════════════════════════════════════════════════════════════
// POLYGON OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute signed area of polygon (positive = CCW, negative = CW)
 */
export function polygonSignedArea(points: Point2D[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

/**
 * Check if polygon winding is counter-clockwise
 */
export function isCounterClockwise(points: Point2D[]): boolean {
  return polygonSignedArea(points) > 0;
}

/**
 * Reverse polygon winding
 */
export function reversePolygon(points: Point2D[]): Point2D[] {
  return [...points].reverse();
}

/**
 * Ensure polygon has counter-clockwise winding
 */
export function ensureCCW(points: Point2D[]): Point2D[] {
  return isCounterClockwise(points) ? points : reversePolygon(points);
}

/**
 * Ensure polygon has clockwise winding
 */
export function ensureCW(points: Point2D[]): Point2D[] {
  return isCounterClockwise(points) ? reversePolygon(points) : points;
}
