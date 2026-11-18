/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether the declared map position is a plausible one: applied twice, zone
 * number glued to the easting, the wrong Swiss grid, outside the CRS's area,
 * or a height in the wrong unit.
 */

import {
  LV03_EXTENT,
  LV95_EXTENT,
  builtInExtent,
  insideExtent,
  plainCodeFor,
  utmZoneOfEpsg,
  zonePrefixedCodeFor,
} from '../crs.js';
import { crsChange, operationAttribute, operationChange, rotationDegrees, round, toWgs84, type DiagnosisContext } from '../context.js';
import { makeFix, siteMoveChange } from '../fixes.js';
import { matchDoubleGeoreference, modelMapPositions, type DoubleMatch } from '../position.js';
import { AREA_OF_USE_MARGIN_DEGREES, insideAreaOfUse } from '../area.js';
import type { GeorefFinding, SkippedCheck, SuggestedFix } from '../types.js';

/** |OrthogonalHeight| above 10 km is above every mountain and below no realistic structure; 1000× smaller usually fits. */
export const MAX_PLAUSIBLE_HEIGHT_METRES = 10_000;

function doubleFinding(ctx: DiagnosisContext, match: DoubleMatch): GeorefFinding {
  const op = ctx.operation as NonNullable<DiagnosisContext['operation']>;
  const L = ctx.lengthScale;
  const rotation = rotationDegrees(op) ?? 0;
  const rotated = Math.abs(rotation) > 1e-6;
  const km = Math.round(Math.hypot(match.anchorMetres.x, match.anchorMetres.y) / 1000);
  const fixes: SuggestedFix[] = [];
  const zeroOffsets = (what: string) => makeFix(
    ctx,
    `${fixes.length ? 'Or keep' : 'Keep'} the ${what} and set the map conversion offsets and turn to zero, so it only names the CRS.`,
    [
      operationChange(op, operationAttribute(op, 'eastings'), 0),
      operationChange(op, operationAttribute(op, 'northings'), 0),
      ...(op.source === 'IfcRigidOperation' ? [] : [
        operationChange(op, 'XAxisAbscissa', 1),
        operationChange(op, 'XAxisOrdinate', 0),
        operationChange(op, 'Scale', round(L / match.mapScale, 9)),
      ]),
    ],
    'Viewers draw in single precision; coordinates of hundreds of kilometres jitter at the millimetre level.',
  );
  let message: string;
  if (match.carrier === 'site') {
    const shift = match.kind === 'unitMismatchedAnchor'
      ? { x: op.eastings, y: op.northings, z: 0 }
      : { x: match.anchorMetres.x / L, y: match.anchorMetres.y / L, z: 0 };
    const move = siteMoveChange(ctx, shift);
    if (move) {
      const caveats = [
        move.caveat,
        rotated ? `The map conversion turns the model by ${round(rotation, 4)}°, which these map-aligned coordinates never received; check the orientation after moving the site.` : undefined,
      ].filter(Boolean).join(' ');
      fixes.push(makeFix(
        ctx,
        'Move the site placement back to the local origin and keep the map conversion: big numbers belong in the map conversion.',
        [move.change],
        caveats || undefined,
      ));
    }
    fixes.push(zeroOffsets('absolute site placement'));
    message = match.kind === 'unitMismatchedAnchor'
      ? `The site placement repeats the map conversion's Eastings/Northings as numbers in the wrong unit, so a tool that applies the map conversion adds the position again and the model lands about ${km} km off: move the site back to the local origin.`
      : `The site placement already sits at the map position that the map conversion adds again, so a tool that applies the map conversion puts the model about ${km} km off: big coordinates in the placements are not georeferencing, move the site back to the local origin.`;
  } else {
    // The geometry itself is written in map coordinates; nothing in the site
    // placement can be moved, so the only edit a file can take is the
    // conversion's. Moving the geometry back is an authoring-tool job.
    fixes.push(zeroOffsets('absolute geometry'));
    const family = match.family === 'pointLists' ? 'tessellated geometry (IfcCartesianPointList)' : 'geometry (IfcCartesianPoint)';
    message = `The ${family} is already written in map coordinates and the map conversion adds the map position again, so a tool that applies the map conversion puts the model about ${km} km off: set the map conversion's offsets to zero, or re-export the geometry relative to the local origin.`;
  }
  return {
    code: 'MAP_POSITION_APPLIED_TWICE',
    severity: 'error',
    message,
    evidence: {
      signature: match.kind,
      carrier: match.carrier,
      family: match.family ?? null,
      anchorEastMetres: round(match.anchorMetres.x),
      anchorNorthMetres: round(match.anchorMetres.y),
      carrierEastMetres: round(match.carrierMetres.x),
      carrierNorthMetres: round(match.carrierMetres.y),
      conversionRotationDegrees: round(rotation, 6),
    },
    fixes,
  };
}

function zonePrefixFinding(ctx: DiagnosisContext): GeorefFinding | undefined {
  const op = ctx.operation;
  const code = ctx.resolved?.code;
  const zone = code === undefined ? undefined : utmZoneOfEpsg(code);
  if (!op || !zone || code === undefined) return undefined;
  for (const mapScale of ctx.mapScales) {
    const e = op.eastings * mapScale;
    const prefixMetres = zone.zone * 1_000_000;
    if (!zone.zonePrefixed) {
      const remainder = e - prefixMetres;
      if (Math.floor(e / 1_000_000) !== zone.zone || remainder < 100_000 || remainder > 900_000) continue;
      const prefixed = zonePrefixedCodeFor(zone);
      return {
        code: 'EASTING_ZONE_PREFIX',
        severity: 'error',
        message: `The Easting ${round(op.eastings)} has the UTM zone number ${zone.zone} written in front of it, but EPSG:${code} expects it without, so the model lands about ${zone.zone * 1000} km east: remove the zone prefix from the Easting.`,
        evidence: { eastings: op.eastings, zone: zone.zone, epsg: code, eastingWithoutPrefix: round(remainder / mapScale) },
        fixes: [
          makeFix(ctx, `Remove the zone prefix: Easting ${round(remainder / mapScale)}.`, [operationChange(op, operationAttribute(op, 'eastings'), round(remainder / mapScale))]),
          ...(prefixed ? [makeFix(ctx, `Or keep the Easting and declare the zone-prefixed CRS EPSG:${prefixed}.`, [crsChange(ctx.crs, 'Name', `EPSG:${prefixed}`)])] : []),
        ],
      };
    }
    if (e < 100_000 || e > 900_000) continue;
    const plain = plainCodeFor(zone);
    return {
      code: 'EASTING_ZONE_PREFIX_MISSING',
      severity: 'error',
      message: `EPSG:${code} expects the zone number ${zone.zone} in front of the Easting, but ${round(op.eastings)} has none, so the model lands about ${zone.zone * 1000} km west: add the prefix or declare the plain UTM CRS.`,
      evidence: { eastings: op.eastings, zone: zone.zone, epsg: code },
      fixes: [
        ...(plain ? [makeFix(ctx, `Declare the plain UTM CRS EPSG:${plain}.`, [crsChange(ctx.crs, 'Name', `EPSG:${plain}`)])] : []),
        makeFix(ctx, `Or add the zone prefix: Easting ${round((e + prefixMetres) / mapScale)}.`, [operationChange(op, operationAttribute(op, 'eastings'), round((e + prefixMetres) / mapScale))]),
      ],
    };
  }
  return undefined;
}

function swissGridFinding(ctx: DiagnosisContext): GeorefFinding | undefined {
  const op = ctx.operation;
  const code = ctx.resolved?.code;
  if (!op || (code !== 2056 && code !== 21781)) return undefined;
  const declaredLv95 = code === 2056;
  const other = declaredLv95 ? LV03_EXTENT : LV95_EXTENT;
  for (const mapScale of ctx.mapScales) {
    const e = op.eastings * mapScale;
    const n = op.northings * mapScale;
    if (!insideExtent(other, e, n)) continue;
    const sign = declaredLv95 ? 1 : -1;
    return {
      code: 'LV03_LV95_MIX',
      severity: 'error',
      message: declaredLv95
        ? `The CRS is LV95 (EPSG:2056) but the Eastings/Northings ${round(op.eastings)} / ${round(op.northings)} are old LV03 numbers, so the model lands about 2,200 km off: declare EPSG:21781, or convert the numbers to LV95.`
        : `The CRS is LV03 (EPSG:21781) but the Eastings/Northings ${round(op.eastings)} / ${round(op.northings)} are LV95 numbers, so the model lands about 2,200 km off: declare EPSG:2056.`,
      evidence: { epsg: code, eastings: op.eastings, northings: op.northings },
      fixes: [
        makeFix(ctx, `Declare the grid the numbers are in: EPSG:${declaredLv95 ? 21781 : 2056}.`, [crsChange(ctx.crs, 'Name', `EPSG:${declaredLv95 ? 21781 : 2056}`)]),
        makeFix(
          ctx,
          `Or shift the numbers into ${declaredLv95 ? 'LV95' : 'LV03'} by ${declaredLv95 ? 'adding' : 'subtracting'} 2,000,000 / 1,000,000 m.`,
          [
            operationChange(op, operationAttribute(op, 'eastings'), round(op.eastings + (sign * 2_000_000) / mapScale)),
            operationChange(op, operationAttribute(op, 'northings'), round(op.northings + (sign * 1_000_000) / mapScale)),
          ],
          'LV03 and LV95 also differ locally by up to about 1.6 m; for survey accuracy transform with swisstopo REFRAME/FINELTRA instead.',
        ),
      ],
    };
  }
  return undefined;
}

const RESCALE_CANDIDATES: ReadonlyArray<[number, string]> = [
  [0.001, 'millimetres'], [0.01, 'centimetres'], [0.1, 'decimetres'], [0.3048, 'feet'],
  [1000, 'kilometres'], [1 / 0.3048, 'metres in a foot map'],
];

function outsideAreaFinding(ctx: DiagnosisContext, double: DoubleMatch | undefined, skipped: SkippedCheck[]): GeorefFinding | undefined {
  const op = ctx.operation;
  const code = ctx.resolved?.code;
  if (!op || code === undefined || ctx.crs?.source === 'IfcGeographicCRS') return undefined;
  const extent = builtInExtent(code);
  const area = ctx.catalogEntry?.areaOfUse;
  const reprojector = ctx.options.reprojector;
  const positions = modelMapPositions(ctx, double);
  let reprojectError: string | undefined;
  let inside: (e: number, n: number) => boolean | undefined;
  let basis: string;
  if (extent) {
    inside = (e, n) => insideExtent(extent, e, n);
    basis = extent.basis;
  } else if (area && reprojector) {
    inside = (e, n) => {
      const geo = toWgs84(ctx, code, e, n);
      if (!geo || 'error' in geo) {
        if (geo) reprojectError = geo.error;
        return undefined;
      }
      return insideAreaOfUse(area, geo.latitude, geo.longitude);
    };
    basis = `EPSG area of use (+${AREA_OF_USE_MARGIN_DEGREES}°)`;
  } else {
    skipped.push({ code: 'OUTSIDE_CRS_AREA', reason: `No extent for EPSG:${code}: inject a crsCatalog with areaOfUse and a reprojector.` });
    return undefined;
  }
  const verdicts = positions.map(({ position }) => inside(position.x, position.y));
  if (verdicts.some((v) => v === undefined)) {
    skipped.push({ code: 'OUTSIDE_CRS_AREA', reason: reprojectError ? `The reprojector failed for EPSG:${code}: ${reprojectError}` : `The reprojector cannot handle EPSG:${code}.` });
    return undefined;
  }
  if (verdicts.some((v) => v === true)) return undefined;
  const { mapScale, position } = positions[0];
  const fixes: SuggestedFix[] = [];
  if (!double) {
    if (inside(op.northings * mapScale, op.eastings * mapScale)) {
      fixes.push(makeFix(ctx, 'Swap Eastings and Northings: they are written the wrong way round.', [
        operationChange(op, operationAttribute(op, 'eastings'), op.northings),
        operationChange(op, operationAttribute(op, 'northings'), op.eastings),
      ]));
    }
    for (const [factor, label] of RESCALE_CANDIDATES) {
      if (!inside(op.eastings * mapScale * factor, op.northings * mapScale * factor)) continue;
      fixes.push(makeFix(ctx, `Eastings/Northings look like ${label}: rescale them to the map unit.`, [
        operationChange(op, operationAttribute(op, 'eastings'), round(op.eastings * factor)),
        operationChange(op, operationAttribute(op, 'northings'), round(op.northings * factor)),
      ]));
      break;
    }
  }
  return {
    code: 'OUTSIDE_CRS_AREA',
    severity: 'error',
    message: `The map position E ${round(position.x, 0)} / N ${round(position.y, 0)} m lies outside where EPSG:${code} is used, so the model lands somewhere it cannot be: check the EPSG code, the unit and the order of Eastings and Northings.`,
    evidence: { epsg: code, eastMetres: round(position.x), northMetres: round(position.y), basis },
    fixes,
  };
}

function heightFinding(ctx: DiagnosisContext): GeorefFinding | undefined {
  const op = ctx.operation;
  if (!op || ctx.crs?.source === 'IfcGeographicCRS') return undefined;
  const heights = ctx.mapScales.map((s) => op.orthogonalHeight * s);
  if (!heights.every((h) => Math.abs(h) > MAX_PLAUSIBLE_HEIGHT_METRES)) return undefined;
  const fits = heights.every((h) => Math.abs(h / 1000) <= MAX_PLAUSIBLE_HEIGHT_METRES);
  return {
    code: 'ORTHOGONAL_HEIGHT_IMPLAUSIBLE',
    severity: 'warning',
    message: `OrthogonalHeight ${round(op.orthogonalHeight)} puts the project origin ${Math.round(heights[0] / 1000)} km ${heights[0] > 0 ? 'above' : 'below'} the datum, which is not a real place; it is usually a height written in millimetres: write it in the map unit.`,
    evidence: { orthogonalHeight: op.orthogonalHeight, heightMetres: round(heights[0]), thresholdMetres: MAX_PLAUSIBLE_HEIGHT_METRES },
    fixes: fits
      ? [makeFix(ctx, `Write the height in the map unit: ${round(op.orthogonalHeight / 1000)}.`, [operationChange(op, operationAttribute(op, 'orthogonalHeight'), round(op.orthogonalHeight / 1000))])]
      : [],
  };
}

export function detectPosition(ctx: DiagnosisContext, skipped: SkippedCheck[]): { findings: GeorefFinding[]; double?: DoubleMatch } {
  const findings: GeorefFinding[] = [];
  const double = matchDoubleGeoreference(ctx);
  if (double) findings.push(doubleFinding(ctx, double));
  const specific = zonePrefixFinding(ctx) ?? swissGridFinding(ctx);
  if (specific) findings.push(specific);
  else {
    const outside = outsideAreaFinding(ctx, double, skipped);
    if (outside) findings.push(outside);
  }
  const height = heightFinding(ctx);
  if (height) findings.push(height);
  return { findings, double };
}
