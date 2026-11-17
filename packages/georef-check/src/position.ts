/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the operation puts the model, per map-unit reading, and whether the
 * placements carry that same position a second time.
 */

import { atMapMagnitude, farGeometry, type DiagnosisContext, type GeometryMedian } from './context.js';
import type { OperationFact, Vec2 } from './types.js';

/**
 * Model centre within this many metres of the declared anchor means the
 * geometry already carries it. Same value as the viewer's
 * NORMAL_COORD_THRESHOLD_M, which its map-absolute guard uses for the same
 * test, so this report and the viewer's correction agree.
 */
export const DOUBLE_GEOREF_RADIUS_METRES = 10_000;

/**
 * The #9480 signature (site placement repeats the anchor NUMBERS in map units
 * inside a file with another length unit) matches within this fraction of the
 * anchor's own magnitude, as in the viewer's guard.
 */
export const UNIT_MISMATCH_RELATIVE_RADIUS = 0.1;

/**
 * The unit-slipped anchor signature needs the project unit and the map unit
 * to differ by at least this factor (either way). Below it, "the same numbers
 * in another unit" lands within the plain-anchor radius anyway or is a grid
 * factor, not a unit; every real unit pair (mm/m 1000, cm/m 100, ft/m 3.28)
 * is far above it.
 */
export const UNIT_MISMATCH_MIN_UNIT_RATIO = 2;

/** Unit vector of the operation's x axis; identity when unset or unusable. */
export function axisOf(op: OperationFact): { a: number; b: number } {
  const a = op.xAxisAbscissa ?? 1;
  const b = op.xAxisOrdinate ?? 0;
  const len = Math.hypot(a, b);
  if (!Number.isFinite(len) || len === 0) return { a: 1, b: 0 };
  return { a: a / len, b: b / len };
}

export interface DoubleMatch {
  kind: 'anchor' | 'unitMismatchedAnchor';
  /** What carries the anchor: the site placement, or one coordinate family of the geometry. */
  carrier: 'site' | 'geometry';
  /** For a geometry carrier, which family. */
  family?: GeometryMedian['family'];
  mapScale: number;
  anchorMetres: Vec2;
  carrierMetres: Vec2;
}

/** Does the site or a coordinate family already sit at the operation's anchor? First matching map-unit reading wins. */
export function matchDoubleGeoreference(ctx: DiagnosisContext): DoubleMatch | undefined {
  const op = ctx.operation;
  if (!op) return undefined;
  for (const mapScale of ctx.mapScales) {
    const anchor = { x: op.eastings * mapScale, y: op.northings * mapScale };
    if (!atMapMagnitude(anchor)) continue;
    const near = (at: Vec2 | undefined) => !!at && Math.hypot(at.x - anchor.x, at.y - anchor.y) < DOUBLE_GEOREF_RADIUS_METRES;
    if (near(ctx.siteOriginMetres)) {
      return { kind: 'anchor', carrier: 'site', mapScale, anchorMetres: anchor, carrierMetres: ctx.siteOriginMetres as Vec2 };
    }
    for (const g of ctx.geometryMedians) {
      if (near(g.metres)) return { kind: 'anchor', carrier: 'geometry', family: g.family, mapScale, anchorMetres: anchor, carrierMetres: g.metres };
    }
    const ratio = ctx.lengthScale / mapScale;
    const raw = ctx.facts.coordinates?.siteOrigin;
    const distinct = Number.isFinite(ratio) && ratio > 0
      && (ratio <= 1 / UNIT_MISMATCH_MIN_UNIT_RATIO || ratio >= UNIT_MISMATCH_MIN_UNIT_RATIO);
    if (raw && distinct && ctx.siteOriginMetres
      && Math.hypot(raw.x - op.eastings, raw.y - op.northings) < UNIT_MISMATCH_RELATIVE_RADIUS * Math.hypot(op.eastings, op.northings)) {
      return { kind: 'unitMismatchedAnchor', carrier: 'site', mapScale, anchorMetres: anchor, carrierMetres: ctx.siteOriginMetres };
    }
  }
  return undefined;
}

/**
 * Where the operation puts a local point (metres, horizontal) in map metres,
 * assuming Scale bridges the units correctly (a wrong Scale is its own
 * finding): `anchor + R · local`.
 */
export function mapPositionOf(op: OperationFact, mapScale: number, local: Vec2 | undefined): Vec2 {
  const { a, b } = axisOf(op);
  const x = local?.x ?? 0;
  const y = local?.y ?? 0;
  return {
    x: op.eastings * mapScale + a * x - b * y,
    y: op.northings * mapScale + b * x + a * y,
  };
}

/**
 * The local points that stand for "where the model is", horizontally, in
 * metres: the site origin when it is at map magnitude, else every coordinate
 * family whose own median is (a conversion with zero offsets over absolute
 * coordinates is valid), else the local origin. When the anchor is applied
 * twice, the local origin alone: the conversion's numbers are the true
 * position there, and the doubled one is reported as such.
 */
export function modelLocalCandidates(ctx: DiagnosisContext, double: DoubleMatch | undefined): Array<Vec2 | undefined> {
  if (double) return [undefined];
  if (atMapMagnitude(ctx.siteOriginMetres)) return [ctx.siteOriginMetres];
  const far = farGeometry(ctx);
  return far.length > 0 ? far.map((g) => g.metres) : [undefined];
}

/**
 * The model's map positions for extent checks: every map-unit reading times
 * every local candidate. A position defect must hold for all of them.
 */
export function modelMapPositions(ctx: DiagnosisContext, double: DoubleMatch | undefined): Array<{ mapScale: number; position: Vec2 }> {
  const op = ctx.operation;
  if (!op) return [];
  const locals = modelLocalCandidates(ctx, double);
  return ctx.mapScales.flatMap((mapScale) => locals.map((local) => ({ mapScale, position: mapPositionOf(op, mapScale, local) })));
}
