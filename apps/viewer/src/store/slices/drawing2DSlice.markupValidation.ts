/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Runtime validators for persisted 2D drawing markup, one per markup kind.
 *
 * Moved out of `drawing2DSlice.persistence.ts` unchanged, so that file stays
 * under the module-size limit (`scripts/module-size-allowlist.txt`) as new
 * markup kinds register there. A validator returns `false` for anything a
 * stored entry could hold that the slice cannot render; the loader filters
 * such items out instead of failing the whole entry.
 */

import type {
  CloudAnnotation2D,
  Measure2DResult,
  PolygonArea2DResult,
  Point2D,
  TextAnnotation2D,
} from './drawing2DSlice.js';

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
export function isPoint2D(v: unknown): v is Point2D {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return isFiniteNumber(p.x) && isFiniteNumber(p.y);
}

export function isPoint2DArray(v: unknown): v is Point2D[] {
  return Array.isArray(v) && v.every(isPoint2D);
}

export function isMeasure2DResult(v: unknown): v is Measure2DResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    isPoint2D(r.start) && isPoint2D(r.end) &&
    isFiniteNumber(r.distance)
  );
}

export function isPolygonArea2DResult(v: unknown): v is PolygonArea2DResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    isPoint2DArray(r.points) && r.points.length >= 3 &&
    isFiniteNumber(r.area) && isFiniteNumber(r.perimeter)
  );
}

export function isTextAnnotation2D(v: unknown): v is TextAnnotation2D {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === 'string' && a.id.length > 0 &&
    isPoint2D(a.position) &&
    typeof a.text === 'string' &&
    isFiniteNumber(a.fontSize) &&
    typeof a.color === 'string' &&
    typeof a.backgroundColor === 'string' &&
    typeof a.borderColor === 'string'
  );
}

export function isCloudAnnotation2D(v: unknown): v is CloudAnnotation2D {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === 'string' && a.id.length > 0 &&
    isPoint2DArray(a.points) && a.points.length >= 2 &&
    typeof a.color === 'string' &&
    typeof a.label === 'string'
  );
}
