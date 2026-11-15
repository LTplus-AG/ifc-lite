/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the operation puts the model, per map-unit reading, and whether the
 * placements carry that same position a second time.
 */

import { MAP_MAGNITUDE_METRES, type DiagnosisContext } from './context.js';
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
  /** What carries the anchor. */
  carrier: 'site' | 'geometry';
  mapScale: number;
  anchorMetres: Vec2;
  carrierMetres: Vec2;
}

/** Does the geometry already sit at the operation's anchor? First matching map-unit reading wins. */
export function matchDoubleGeoreference(ctx: DiagnosisContext): DoubleMatch | undefined {
  const op = ctx.operation;
  if (!op) return undefined;
  for (const mapScale of ctx.mapScales) {
    const anchor = { x: op.eastings * mapScale, y: op.northings * mapScale };
    if (!(Math.hypot(anchor.x, anchor.y) >= MAP_MAGNITUDE_METRES)) continue;
    const carriers: Array<['site' | 'geometry', Vec2 | undefined]> = [
      ['site', ctx.siteOriginMetres],
      ['geometry', ctx.pointMedianMetres],
    ];
    for (const [carrier, at] of carriers) {
      if (at && Math.hypot(at.x - anchor.x, at.y - anchor.y) < DOUBLE_GEOREF_RADIUS_METRES) {
        return { kind: 'anchor', carrier, mapScale, anchorMetres: anchor, carrierMetres: at };
      }
    }
    const ratio = ctx.lengthScale / mapScale;
    const raw = ctx.facts.coordinates?.siteOrigin;
    const distinct = Number.isFinite(ratio) && ratio > 0 && (ratio <= 0.5 || ratio >= 2);
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
 * The map position of the model for extent checks, per map-unit reading.
 * The local point is the site origin, else the geometry median, when either
 * is at map magnitude (a conversion with zero offsets over absolute
 * coordinates is valid); otherwise the local origin. When the anchor is
 * applied twice, the anchor alone: the conversion's numbers are the true
 * position there, and the doubled one is reported as such.
 */
export function modelMapPositions(ctx: DiagnosisContext, double: DoubleMatch | undefined): Array<{ mapScale: number; position: Vec2 }> {
  const op = ctx.operation;
  if (!op) return [];
  const far = (v: Vec2 | undefined) => (v && Math.hypot(v.x, v.y) >= MAP_MAGNITUDE_METRES ? v : undefined);
  const local = double ? undefined : far(ctx.siteOriginMetres) ?? far(ctx.pointMedianMetres);
  return ctx.mapScales.map((mapScale) => ({ mapScale, position: mapPositionOf(op, mapScale, local) }));
}
