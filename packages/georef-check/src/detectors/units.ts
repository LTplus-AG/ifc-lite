/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scale and unit slips between the project length unit, the map unit and the
 * map conversion's Scale (IFC: Scale converts project units to map units, so
 * a correct Scale is `lengthUnit / mapUnit` times a grid factor near 1).
 */

import { crsChange, crsUnitScale, operationChange, round, type DiagnosisContext } from '../context.js';
import type { GeorefFinding } from '../types.js';

/** Grid scale factors (UTM 0.9996, combined factors) stay within 5% of 1; anything inside is not a unit slip. */
export const SCALE_GRID_FACTOR_BAND = 0.05;
/** A ratio within 2% of a power of ten is a metric unit slip. */
export const POWER_OF_TEN_TOLERANCE = 0.02;
/** A ratio within 1% of 0.3048 (or its inverse) is a foot/metre slip. */
export const FOOT_TOLERANCE = 0.01;
/** An off-1 ratio not explained by a unit and outside [0.5, 2] is still reported, as a warning. */
export const UNEXPLAINED_SCALE_BAND: readonly [number, number] = [0.5, 2];

const FOOT = 0.3048;

function nearOne(ratio: number): boolean {
  return Math.abs(ratio - 1) <= SCALE_GRID_FACTOR_BAND;
}

/** Which unit slip explains `ratio`, if any. */
export function explainRatio(ratio: number): string | undefined {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return undefined;
  const exponent = Math.round(Math.log10(ratio));
  if (exponent !== 0 && Math.abs(ratio / 10 ** exponent - 1) <= POWER_OF_TEN_TOLERANCE) return `a factor of ${10 ** exponent}`;
  if (Math.abs(ratio / FOOT - 1) <= FOOT_TOLERANCE) return 'metres read as feet';
  if (Math.abs(ratio * FOOT - 1) <= FOOT_TOLERANCE) return 'feet read as metres';
  return undefined;
}

function unitName(scale: number): string {
  const names: Record<string, string> = { '1': 'metres', '0.001': 'millimetres', '0.01': 'centimetres', '0.1': 'decimetres', '0.3048': 'feet', '1000': 'kilometres' };
  return names[String(round(scale, 9))] ?? `units of ${round(scale, 6)} m`;
}

export function detectUnits(ctx: DiagnosisContext): GeorefFinding[] {
  const findings: GeorefFinding[] = [];
  const op = ctx.operation;
  const crs = ctx.crs;
  const L = ctx.lengthScale;

  if (crs && crs.source !== 'IfcGeographicCRS' && !ctx.mapUnitKnown) {
    const metreCrs = crsUnitScale(ctx) === 1;
    const ambiguous = ctx.mapScales.length > 1;
    findings.push({
      code: 'MAP_UNIT_MISSING',
      severity: ambiguous ? 'warning' : 'info',
      message: ambiguous
        ? `The CRS has no MapUnit, and readers disagree whether the Eastings are then in the project's ${unitName(L)} or in the CRS's unit, which here differ: set MapUnit explicitly.`
        : 'The CRS has no MapUnit; readers fall back to the project unit or the CRS unit, which agree here, but setting MapUnit removes the guess.',
      evidence: { lengthUnitMetres: L, readingsMetres: ctx.mapScales.join(' | ') },
      fixes: [{
        summary: metreCrs ? 'Set MapUnit to metre, the unit of this CRS.' : 'Set MapUnit to the unit of the CRS.',
        changes: [crsChange(crs, 'MapUnit', metreCrs ? 'METRE' : null)],
      }],
    });
  }

  if (!op || op.source === 'IfcRigidOperation') return findings;

  const authored: Array<[string, number | undefined]> = [
    ['Scale', op.scale], ['FactorX', op.factorX], ['FactorY', op.factorY], ['FactorZ', op.factorZ],
  ];
  const invalid = authored.filter(([, v]) => v !== undefined && !(v > 0 && Number.isFinite(v)));
  if (invalid.length > 0) {
    findings.push({
      code: 'SCALE_INVALID',
      severity: 'error',
      message: `${invalid.map(([name]) => name).join(', ')} must be a positive number, so tools either refuse the map conversion or collapse the model: write the unit conversion factor instead.`,
      evidence: Object.fromEntries(invalid.map(([name, v]) => [name, v ?? null])),
      fixes: ctx.mapUnitKnown
        ? [{ summary: 'Set Scale to the project-to-map unit factor.', changes: [operationChange(op, 'Scale', round(L / ctx.mapScales[0], 9))] }]
        : [],
    });
    return findings;
  }
  if (!ctx.mapUnitKnown) return findings;

  const M = ctx.mapScales[0];
  const expected = L / M;
  const scale = op.scale ?? 1;
  const factorsUnit = (op.factorX ?? 1) === 1 && (op.factorY ?? 1) === 1;
  const effective = scale * (op.factorX ?? 1);
  const ratio = effective / expected;
  if (nearOne(ratio)) return findings;

  const evidence = {
    lengthUnitMetres: L,
    mapUnitMetres: M,
    scale: op.scale ?? null,
    factorX: op.factorX ?? null,
    expectedScale: round(expected, 9),
    ratio: round(ratio, 6),
  };
  const fix = { summary: `Set Scale to ${round(expected, 9)} (${unitName(L)} to ${unitName(M)}).`, changes: [operationChange(op, 'Scale', round(expected, 9))] };

  if (scale === 1 && factorsUnit) {
    findings.push({
      code: 'SCALE_DOES_NOT_BRIDGE_UNITS',
      severity: 'warning',
      message: `The project is in ${unitName(L)} and the map in ${unitName(M)}, but Scale is ${op.scale === undefined ? 'unset (meaning 1)' : '1'}, so tools that follow IFC to the letter place the model ${round(1 / expected, 6)}× too big and far away (lenient tools guess right): set Scale to ${round(expected, 9)}.`,
      evidence,
      fixes: [fix],
    });
    return findings;
  }

  const explanation = explainRatio(ratio);
  const [lo, hi] = UNEXPLAINED_SCALE_BAND;
  if (!explanation && ratio >= lo && ratio <= hi) return findings;
  findings.push({
    code: 'SCALE_UNIT_MISMATCH',
    severity: explanation ? 'error' : 'warning',
    message: explanation
      ? `Scale ${round(effective, 9)} is off by ${explanation} from what converts the project's ${unitName(L)} into the map's ${unitName(M)} (${round(expected, 9)}), so the model is placed at the wrong size and distance: set Scale to ${round(expected, 9)}.`
      : `Scale ${round(effective, 9)} differs from the unit conversion ${round(expected, 9)} by a factor of ${round(ratio, 4)}, which no unit explains, so the model is placed at the wrong size: check the Scale.`,
    evidence: { ...evidence, explanation: explanation ?? null },
    fixes: factorsUnit ? [fix] : [{ ...fix, caveat: 'The file also authors IfcMapConversionScaled factors; check whether they, not Scale, carry the unit.' }],
  });
  return findings;
}
