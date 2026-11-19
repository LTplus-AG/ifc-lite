/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Several precise sources in one file that say different things: an IFC4
 * entity beside an IFC2x3 property set, or more than one IfcMapConversion.
 * Tools pick different winners, so the model lands in different places.
 */

import { resolveCrs } from '../crs.js';
import { rotationDegrees, round, type DiagnosisContext } from '../context.js';
import type { CrsFact, GeorefFinding, OperationFact } from '../types.js';

/** Offsets further apart than this (metres) are different positions, not rounding. */
export const SOURCE_OFFSET_TOLERANCE_METRES = 1;
/** Turns further apart than this are different orientations. */
export const SOURCE_ROTATION_TOLERANCE_DEGREES = 0.01;
/**
 * Scales whose ratio differs from 1 by more than this are different. 1e-6 is
 * 1 mm per kilometre: below any survey tolerance, so rounding in a writer's
 * float formatting (0.001 vs 0.0010000000000000002) never trips it, while a
 * real difference (a grid factor 0.9996 against 1, or a unit) is far above it.
 */
export const SOURCE_SCALE_RELATIVE_TOLERANCE = 1e-6;

interface Difference {
  field: string;
  a: number | string;
  b: number | string;
}

function compare(
  ctx: DiagnosisContext,
  a: OperationFact,
  aCrs: CrsFact | undefined,
  b: OperationFact,
  bCrs: CrsFact | undefined,
): Difference[] {
  const diffs: Difference[] = [];
  const scaleA = aCrs?.mapUnitScale ?? ctx.mapScales[0];
  const scaleB = bCrs?.mapUnitScale ?? ctx.mapScales[0];
  const de = Math.abs(a.eastings * scaleA - b.eastings * scaleB);
  const dn = Math.abs(a.northings * scaleA - b.northings * scaleB);
  if (de > SOURCE_OFFSET_TOLERANCE_METRES) diffs.push({ field: 'Eastings', a: a.eastings, b: b.eastings });
  if (dn > SOURCE_OFFSET_TOLERANCE_METRES) diffs.push({ field: 'Northings', a: a.northings, b: b.northings });
  const ra = rotationDegrees(a);
  const rb = rotationDegrees(b);
  if (ra !== undefined && rb !== undefined && Math.abs(ra - rb) > SOURCE_ROTATION_TOLERANCE_DEGREES) {
    diffs.push({ field: 'rotationDegrees', a: round(ra, 6), b: round(rb, 6) });
  }
  const sa = a.scale ?? 1;
  const sb = b.scale ?? 1;
  if (a.source !== 'IfcRigidOperation' && b.source !== 'IfcRigidOperation' && Math.abs(sa / sb - 1) > SOURCE_SCALE_RELATIVE_TOLERANCE) {
    diffs.push({ field: 'Scale', a: sa, b: sb });
  }
  const codeA = resolveCrs(aCrs, ctx.options.crsCatalog)?.code;
  const codeB = resolveCrs(bCrs, ctx.options.crsCatalog)?.code;
  if (codeA !== undefined && codeB !== undefined && codeA !== codeB) {
    diffs.push({ field: 'EPSG', a: codeA, b: codeB });
  }
  return diffs;
}

function finding(what: string, winner: string, diffs: Difference[]): GeorefFinding {
  const evidence: GeorefFinding['evidence'] = {};
  for (const d of diffs) {
    evidence[`${d.field}.first`] = d.a;
    evidence[`${d.field}.second`] = d.b;
  }
  return {
    code: 'SOURCES_DISAGREE',
    severity: 'warning',
    message: `${what} disagree on ${diffs.map((d) => d.field).join(', ')}, so tools that read a different one place the model differently (ifc-lite uses ${winner}): delete the wrong one or make them match.`,
    evidence: { ...evidence, sources: what },
    fixes: [],
  };
}

export function detectConsistency(ctx: DiagnosisContext): GeorefFinding[] {
  const findings: GeorefFinding[] = [];
  const entity = ctx.facts.entities;
  const ePSet = ctx.facts.ePSet;
  if (entity?.operation && ePSet?.operation) {
    const diffs = compare(ctx, entity.operation, entity.crs, ePSet.operation, ePSet.crs);
    if (diffs.length > 0) {
      findings.push(finding(`The ${entity.operation.source} and the ePSet_MapConversion property set`, entity.operation.source, diffs));
    }
  }
  const extra = ctx.facts.additionalMapConversions ?? [];
  const first = entity?.operation?.source === 'IfcMapConversion' ? entity.operation : undefined;
  if (first) {
    // Each conversion in its own TargetCRS: the same offsets in EPSG:2056 and
    // EPSG:21781 are two different places (bot review on PR #10386).
    for (const other of extra) {
      if (!other.operation || other.operation.entityId === first.entityId) continue;
      const diffs = compare(ctx, first, entity?.crs, other.operation, other.crs);
      if (diffs.length > 0) {
        findings.push(finding(`IfcMapConversion #${first.entityId} and #${other.operation.entityId}`, `#${first.entityId}`, diffs));
        break;
      }
    }
  }
  return findings;
}
