/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Whether the declared CRS is one a GIS tool can use: present, resolvable to EPSG, with a vertical datum. */

import { crsChange, type DiagnosisContext } from '../context.js';
import { makeFix } from '../fixes.js';
import type { GeorefFinding } from '../types.js';

/**
 * Height systems to suggest, only for CRSs used in a single country, where
 * the national height system is unambiguous. A CRS shared by several
 * countries (ETRS89 / UTM 32N spans Norway to Italy) gets no example rather
 * than a wrong one.
 */
export const VERTICAL_DATUM_EXAMPLES: Readonly<Record<number, string>> = {
  2056: '"EPSG:5728" (LN02) or "EPSG:5729" (LHN95)',
  21781: '"EPSG:5728" (LN02) or "EPSG:5729" (LHN95)',
  4647: '"EPSG:7837" (DHHN2016)',
  5649: '"EPSG:7837" (DHHN2016)',
  5650: '"EPSG:7837" (DHHN2016)',
  28992: '"EPSG:5709" (NAP)',
};

export function detectCrs(ctx: DiagnosisContext): GeorefFinding[] {
  const findings: GeorefFinding[] = [];
  const { operation: op, crs, resolved } = ctx;
  const ePSet = op?.source === 'ePSet_MapConversion';
  const usable = !!crs && (crs.name.trim() !== '' || !!crs.wellKnownText);

  if (op && !usable) {
    findings.push({
      code: 'OPERATION_WITHOUT_CRS',
      severity: 'error',
      message: op.source === 'IfcRigidOperation'
        ? 'The IfcRigidOperation moves the model onto a map, but its target CRS has no name or definition, so no tool knows which map: give the IfcProjectedCRS an EPSG code as Name.'
        : 'The map conversion moves the model onto a map, but no CRS with a name or definition says which map: add the EPSG code as the CRS Name.',
      evidence: { operation: op.source, crsPresent: !!crs },
      fixes: [makeFix(ctx, 'Name the target CRS by its EPSG code.', [crsChange(crs, 'Name', null, ePSet)])],
    });
  }

  if (usable && crs && !resolved) {
    findings.push({
      code: 'CRS_NOT_RESOLVABLE',
      severity: 'warning',
      message: `The CRS is named "${crs.name.trim() || '(only a WKT without an EPSG identifier)'}", which is not an EPSG code, so most GIS tools cannot look it up: write the Name as "EPSG:<code>".`,
      evidence: { name: crs.name, hasWellKnownText: !!crs.wellKnownText },
      fixes: [makeFix(ctx, 'Write the CRS Name as its EPSG code.', [crsChange(crs, 'Name', null)])],
    });
  } else if (usable && crs && resolved?.via === 'catalogName') {
    findings.push({
      code: 'CRS_NOT_RESOLVABLE',
      severity: 'info',
      message: `The CRS is named "${crs.name.trim()}" instead of its EPSG code; it matches EPSG:${resolved.code}, but tools without a name catalogue cannot look it up: write the Name as "EPSG:${resolved.code}".`,
      evidence: { name: crs.name, resolvedEpsg: resolved.code },
      fixes: [makeFix(ctx, `Write the CRS Name as EPSG:${resolved.code}.`, [crsChange(crs, 'Name', `EPSG:${resolved.code}`)])],
    });
  }

  const compound = ctx.catalogEntry?.kind === 'compound';
  if (op && usable && crs && crs.source !== 'IfcGeographicCRS' && !crs.verticalDatum?.trim() && !compound) {
    findings.push({
      code: 'VERTICAL_DATUM_MISSING',
      severity: 'info',
      message: `The CRS names no VerticalDatum, so OrthogonalHeight ${op.orthogonalHeight} has no stated reference (sea level of which country?): set VerticalDatum${resolved && VERTICAL_DATUM_EXAMPLES[resolved.code] ? `, here ${VERTICAL_DATUM_EXAMPLES[resolved.code]}` : ' to the EPSG code of the height system the heights are in'}.`,
      evidence: { orthogonalHeight: op.orthogonalHeight, epsg: resolved?.code ?? null },
      fixes: [makeFix(ctx, 'Name the height system in VerticalDatum.', [crsChange(crs, 'VerticalDatum', null)])],
    });
  }
  return findings;
}
