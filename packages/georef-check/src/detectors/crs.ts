/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Whether the declared CRS is one a GIS tool can use: present, resolvable to EPSG, with a vertical datum. */

import { crsChange, type DiagnosisContext } from '../context.js';
import type { GeorefFinding } from '../types.js';

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
      fixes: [{ summary: 'Name the target CRS by its EPSG code.', changes: [crsChange(crs, 'Name', null, ePSet)] }],
    });
  }

  if (usable && crs && !resolved) {
    findings.push({
      code: 'CRS_NOT_RESOLVABLE',
      severity: 'warning',
      message: `The CRS is named "${crs.name.trim() || '(only a WKT without an EPSG identifier)'}", which is not an EPSG code, so most GIS tools cannot look it up: write the Name as "EPSG:<code>".`,
      evidence: { name: crs.name, hasWellKnownText: !!crs.wellKnownText },
      fixes: [{ summary: 'Write the CRS Name as its EPSG code.', changes: [crsChange(crs, 'Name', null)] }],
    });
  } else if (usable && crs && resolved?.via === 'catalogName') {
    findings.push({
      code: 'CRS_NOT_RESOLVABLE',
      severity: 'info',
      message: `The CRS is named "${crs.name.trim()}" instead of its EPSG code; it matches EPSG:${resolved.code}, but tools without a name catalogue cannot look it up: write the Name as "EPSG:${resolved.code}".`,
      evidence: { name: crs.name, resolvedEpsg: resolved.code },
      fixes: [{ summary: `Write the CRS Name as EPSG:${resolved.code}.`, changes: [crsChange(crs, 'Name', `EPSG:${resolved.code}`)] }],
    });
  }

  const compound = ctx.catalogEntry?.kind === 'compound';
  if (op && usable && crs && crs.source !== 'IfcGeographicCRS' && !crs.verticalDatum?.trim() && !compound) {
    findings.push({
      code: 'VERTICAL_DATUM_MISSING',
      severity: 'info',
      message: `The CRS names no VerticalDatum, so OrthogonalHeight ${op.orthogonalHeight} has no stated reference (sea level of which country?): set VerticalDatum, for example "EPSG:5728" (LN02) or "EPSG:7837" (DHHN2016).`,
      evidence: { orthogonalHeight: op.orthogonalHeight, epsg: resolved?.code ?? null },
      fixes: [{ summary: 'Name the height system in VerticalDatum.', changes: [crsChange(crs, 'VerticalDatum', null)] }],
    });
  }
  return findings;
}
