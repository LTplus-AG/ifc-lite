/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading Speckle geometry primitives into metres: points, straight lines,
 * and polygonal outlines. Anything that is not exactly one of those (an
 * arc, a NURBS curve, a gap between polycurve segments) is reported as
 * `undefined` with a reason, so the caller refuses the element rather than
 * approximating its shape.
 */

import type { SpeckleObject } from './client.js';
import { lengthScale } from './units.js';

export type Vec3 = [number, number, number];
export type Resolver = (value: unknown) => Record<string, unknown> | undefined;

/** Resolve a detached `{ speckle_type: 'reference', referencedId }` against the fetched graph; inline objects pass through. */
export function resolverFor(objects: ReadonlyMap<string, SpeckleObject>): Resolver {
  return (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const o = value as Record<string, unknown>;
    if (typeof o.referencedId === 'string') return objects.get(o.referencedId);
    return o;
  };
}

/** `speckle_type` is a `:`-joined inheritance chain; true when `base` is one of its links. */
export function isA(obj: Record<string, unknown> | undefined, base: string): boolean {
  return typeof obj?.speckle_type === 'string' && obj.speckle_type.split(':').includes(base);
}

/** The most-derived link of the chain, the name refusals use. */
export function leafType(obj: Record<string, unknown>): string {
  const t = typeof obj.speckle_type === 'string' ? obj.speckle_type : 'Base';
  const chain = t.split(':');
  const leaf = chain[chain.length - 1];
  return leaf.slice(leaf.lastIndexOf('.') + 1);
}

/** `a Line`, `an Arc`. */
const withArticle = (word: string): string => `${/^[AEIOU]/i.test(word) ? 'an' : 'a'} ${word}`;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A Speckle point in metres; its own `units` win over the owner's. */
export function pointOf(resolve: Resolver, value: unknown, ownerUnits: unknown): Vec3 | undefined {
  const p = resolve(value);
  if (!p || !finite(p.x) || !finite(p.y) || !finite(p.z)) return undefined;
  const s = lengthScale(p.units) ?? lengthScale(ownerUnits);
  if (s === undefined) return undefined;
  return [p.x * s, p.y * s, p.z * s];
}

/** Start/end of an `Objects.Geometry.Line`, in metres. */
export function lineOf(resolve: Resolver, value: unknown, ownerUnits: unknown): { start: Vec3; end: Vec3 } | { reason: string } {
  const line = resolve(value);
  if (!line) return { reason: 'has no location line' };
  if (!isA(line, 'Objects.Geometry.Line')) return { reason: `has ${withArticle(leafType(line))} location, not a straight line` };
  const units = line.units ?? ownerUnits;
  const start = pointOf(resolve, line.start, units);
  const end = pointOf(resolve, line.end, units);
  if (!start || !end) return { reason: 'has a location line without numeric points in a length unit' };
  return { start, end };
}

/** A flat number list, possibly chunked into `DataChunk` references. */
function numbers(resolve: Resolver, value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const item of value) {
    if (finite(item)) out.push(item);
    else {
      const chunk = resolve(item);
      if (!chunk || !Array.isArray(chunk.data) || !chunk.data.every(finite)) return undefined;
      out.push(...(chunk.data as number[]));
    }
  }
  return out;
}

const TOL = 1e-4; // metres: 0.1 mm

function near(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) <= TOL && Math.abs(a[1] - b[1]) <= TOL && Math.abs(a[2] - b[2]) <= TOL;
}

/**
 * The vertices of a closed, planar-horizontal outline (a `Polycurve` of
 * `Line` segments, or a closed `Polyline`), in metres, without the closing
 * duplicate. Everything else — arcs, open or gapped outlines, outlines whose
 * vertices do not share one elevation — returns a reason.
 */
export function outlineOf(resolve: Resolver, value: unknown, ownerUnits: unknown): { points: Vec3[] } | { reason: string } {
  const curve = resolve(value);
  if (!curve) return { reason: 'has no outline' };
  const units = curve.units ?? ownerUnits;
  let points: Vec3[] = [];
  if (isA(curve, 'Objects.Geometry.Polycurve')) {
    const segments = Array.isArray(curve.segments) ? curve.segments : [];
    for (const [i, seg] of segments.entries()) {
      const line = lineOf(resolve, seg, units);
      if ('reason' in line) {
        const s = resolve(seg);
        return { reason: `has an outline with ${withArticle(s ? leafType(s) : 'missing')} segment, not only straight lines` };
      }
      if (i > 0 && !near(points[points.length - 1], line.start)) return { reason: 'has an outline with a gap between segments' };
      if (i === 0) points.push(line.start);
      points.push(line.end);
    }
  } else if (isA(curve, 'Objects.Geometry.Polyline')) {
    const flat = numbers(resolve, curve.value);
    const s = lengthScale(units);
    if (!flat || flat.length % 3 !== 0 || s === undefined) return { reason: 'has a polyline outline without numeric coordinates in a length unit' };
    for (let i = 0; i < flat.length; i += 3) points.push([flat[i] * s, flat[i + 1] * s, flat[i + 2] * s]);
    if (curve.closed !== true && !(points.length > 1 && near(points[0], points[points.length - 1]))) return { reason: 'has an open polyline outline' };
    if (curve.closed === true) points.push(points[0]);
  } else {
    return { reason: `has ${withArticle(leafType(curve))} outline, not line segments` };
  }
  if (points.length < 2 || !near(points[0], points[points.length - 1])) return { reason: 'has an outline that does not close' };
  points = points.slice(0, -1);
  if (points.length < 3) return { reason: 'has an outline with fewer than three vertices' };
  if (points.some((p) => Math.abs(p[2] - points[0][2]) > TOL)) return { reason: 'has an outline that is not horizontal (sloped)' };
  return { points };
}
