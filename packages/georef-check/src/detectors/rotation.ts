/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The map conversion's turn: a usable direction, of unit length, and in
 * agreement with the context's TrueNorth.
 */

import { operationChange, rotationDegrees, round, type DiagnosisContext } from '../context.js';
import { makeFix } from '../fixes.js';
import type { GeorefFinding } from '../types.js';

/** 1 mm per metre: below that a non-unit vector is rounding, above it a cos/sin reader visibly scales the model. */
export const UNIT_LENGTH_TOLERANCE = 1e-3;
/**
 * Grid north and true north differ by the meridian convergence, under about
 * 3° inside any UTM zone at the latitudes people build at, and far less in
 * national grids. 5° is beyond convergence, so a larger gap is a real
 * contradiction.
 */
export const TRUE_NORTH_TOLERANCE_DEGREES = 5;

function angleBetween(a: number, b: number): number {
  const d = (((a - b) % 360) + 540) % 360 - 180;
  return Math.abs(d);
}

export function detectRotation(ctx: DiagnosisContext): GeorefFinding[] {
  const findings: GeorefFinding[] = [];
  const op = ctx.operation;
  if (!op || op.source === 'IfcRigidOperation') return findings;
  const a = op.xAxisAbscissa;
  const b = op.xAxisOrdinate;

  if ((a === undefined) !== (b === undefined)) {
    // Readers fill the missing component with the default (abscissa 1,
    // ordinate 0). When that gives a unit vector, (1, unset) or (unset, 0),
    // every reader agrees on "no turn" and nothing is ambiguous.
    const filled = Math.hypot(a ?? 1, b ?? 0);
    // The filled-in vector is still compared with TrueNorth, exactly as the
    // same turn written out in full.
    if (Math.abs(filled - 1) <= UNIT_LENGTH_TOLERANCE) return detectTrueNorthContradiction(ctx, findings);
    findings.push({
      code: 'ROTATION_INVALID',
      severity: 'warning',
      message: `Only ${a === undefined ? 'XAxisOrdinate' : 'XAxisAbscissa'} is set, so tools fill in the other one differently and may turn the model differently: set both, as the cosine and sine of the turn.`,
      evidence: { xAxisAbscissa: a ?? null, xAxisOrdinate: b ?? null },
      fixes: [],
    });
    return findings;
  }
  // Both unset: IFC defaults to no turn (1, 0), compared with TrueNorth like the same turn written out.
  if (a === undefined && b === undefined) return detectTrueNorthContradiction(ctx, findings);
  if (a === undefined || b === undefined) return findings;
  const length = Math.hypot(a, b);
  if (!Number.isFinite(length) || length === 0) {
    findings.push({
      code: 'ROTATION_INVALID',
      severity: 'error',
      message: 'XAxisAbscissa and XAxisOrdinate are both zero, which is no direction at all, so tools refuse the turn or the whole map conversion: write the cosine and sine of the turn (1 and 0 for none).',
      evidence: { xAxisAbscissa: a, xAxisOrdinate: b },
      fixes: [makeFix(ctx, 'Write the no-turn direction (1, 0), or the real turn.', [operationChange(op, 'XAxisAbscissa', 1), operationChange(op, 'XAxisOrdinate', 0)])],
    });
    return findings;
  }
  if (Math.abs(length - 1) > UNIT_LENGTH_TOLERANCE) {
    findings.push({
      code: 'ROTATION_NOT_UNIT_LENGTH',
      severity: 'warning',
      message: `XAxisAbscissa/XAxisOrdinate (${a}, ${b}) has length ${round(length, 6)} instead of 1, so tools that use them as cosine and sine also scale the model by ${round(length, 6)}: write the normalised values.`,
      evidence: { xAxisAbscissa: a, xAxisOrdinate: b, length: round(length, 9), tolerance: UNIT_LENGTH_TOLERANCE },
      fixes: [makeFix(ctx, 'Write the normalised direction.', [operationChange(op, 'XAxisAbscissa', round(a / length, 12)), operationChange(op, 'XAxisOrdinate', round(b / length, 12))])],
    });
  }

  return detectTrueNorthContradiction(ctx, findings);
}

function detectTrueNorthContradiction(ctx: DiagnosisContext, findings: GeorefFinding[]): GeorefFinding[] {
  const op = ctx.operation;
  if (!op) return findings;
  const north = ctx.facts.trueNorth;
  const theta = rotationDegrees(op);
  if (!north || theta === undefined || Math.hypot(north.x, north.y) === 0) return findings;
  const isDefaultNorth = Math.abs(north.x) < 1e-9 && north.y > 0;
  // Grid north (map +y) seen in the local frame: the conversion turns local x
  // by theta anticlockwise onto the map, so map north is local (sin θ, cos θ).
  const gridNorthLocal = (Math.atan2(Math.cos((theta * Math.PI) / 180), Math.sin((theta * Math.PI) / 180)) * 180) / Math.PI;
  const reversedLocal = (Math.atan2(Math.cos((theta * Math.PI) / 180), -Math.sin((theta * Math.PI) / 180)) * 180) / Math.PI;
  const trueNorthLocal = (Math.atan2(north.y, north.x) * 180) / Math.PI;
  const gap = angleBetween(trueNorthLocal, gridNorthLocal);
  if (gap <= TRUE_NORTH_TOLERANCE_DEGREES) return findings;
  const reversed = angleBetween(trueNorthLocal, reversedLocal) <= TRUE_NORTH_TOLERANCE_DEGREES;
  findings.push({
    code: 'TRUE_NORTH_CONTRADICTS_ROTATION',
    severity: isDefaultNorth ? 'info' : 'warning',
    message: isDefaultNorth
      ? `The map conversion turns the model by ${round(theta, 3)}° but TrueNorth is left at the default "up", so tools that orient by TrueNorth (sun studies, north arrows) disagree with the map: set TrueNorth to match the turn.`
      : reversed
        ? `TrueNorth is turned the opposite way to the map conversion (${round(theta, 3)}°), the sign of the turn is reversed in one of them, so the model ends up askew by about ${round(2 * Math.abs(theta), 1)}° in some tools: check the sign of XAxisOrdinate.`
        : `TrueNorth and the map conversion's turn (${round(theta, 3)}°) disagree by ${round(gap, 1)}°, more than grid convergence explains, so tools that use one or the other show the model askew: make them agree.`,
    evidence: {
      conversionRotationDegrees: round(theta, 6),
      trueNorthX: north.x,
      trueNorthY: north.y,
      gapDegrees: round(gap, 3),
      toleranceDegrees: TRUE_NORTH_TOLERANCE_DEGREES,
      reversed,
    },
    fixes: [],
  });
  return findings;
}
