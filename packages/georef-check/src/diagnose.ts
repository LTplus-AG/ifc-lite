/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MAP_MAGNITUDE_METRES, buildContext, type DiagnosisContext } from './context.js';
import { detectConsistency } from './detectors/consistency.js';
import { detectCrs } from './detectors/crs.js';
import { detectPosition } from './detectors/position.js';
import { detectPresence } from './detectors/presence.js';
import { detectRotation } from './detectors/rotation.js';
import { detectSiteContradiction } from './detectors/site.js';
import { detectUnits } from './detectors/units.js';
import type { DiagnoseOptions, GeorefFacts, GeorefFindingCode, GeorefLevel, GeorefReport, SkippedCheck } from './types.js';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

const POSITION_DEFECTS: ReadonlySet<GeorefFindingCode> = new Set<GeorefFindingCode>([
  'EASTING_ZONE_PREFIX',
  'EASTING_ZONE_PREFIX_MISSING',
  'LV03_LV95_MIX',
  'OUTSIDE_CRS_AREA',
]);

/**
 * buildingSMART Levels of Georeferencing present in the file:
 * - 10: an IfcPostalAddress on the site or building;
 * - 20: IfcSite RefLatitude/RefLongitude;
 * - 30: the site placement at map magnitude (at least 100 km from the origin);
 * - 40: the 3D context's WorldCoordinateSystem off the origin, or an authored TrueNorth other than +y;
 * - 50: IfcMapConversion / IfcRigidOperation, or IFC2x3 ePSet_MapConversion.
 */
export function georeferencingLevels(facts: GeorefFacts, ctx: DiagnosisContext = buildContext(facts, {})): GeorefLevel[] {
  const levels: GeorefLevel[] = [];
  if (facts.hasPostalAddress) levels.push(10);
  if (facts.siteLocation) levels.push(20);
  const site = ctx.siteOriginMetres;
  if (site && Math.hypot(site.x, site.y) >= MAP_MAGNITUDE_METRES) levels.push(30);
  const north = facts.trueNorth;
  const customNorth = !!north && !(Math.abs(north.x) < 1e-9 && north.y > 0);
  const origin = facts.contextOrigin;
  if (customNorth || (origin && (origin.x !== 0 || origin.y !== 0 || origin.z !== 0))) levels.push(40);
  if (facts.entities?.operation || facts.ePSet?.operation) levels.push(50);
  return levels;
}

/**
 * Diagnose a model's georeferencing from its facts. Pure: no I/O, no globals;
 * the reprojector and CRS catalogue are injected and every check that needs
 * a missing one is listed in `skipped` instead of guessed.
 *
 * Precision over recall: each detector fires only on a signature a correct
 * model cannot show (thresholds are documented beside each detector and in
 * the README).
 */
export function diagnoseGeoreference(facts: GeorefFacts, options: DiagnoseOptions = {}): GeorefReport {
  const ctx = buildContext(facts, options);
  const skipped: SkippedCheck[] = [];
  const position = detectPosition(ctx, skipped);
  // A map position already reported as impossible would only be echoed (with
  // a nonsense "set the site to the mid-Atlantic" fix), so the site check waits for it.
  const positionFlagged = position.findings.some((f) => POSITION_DEFECTS.has(f.code));
  if (positionFlagged && facts.siteLocation && ctx.operation) {
    skipped.push({ code: 'SITE_LOCATION_CONTRADICTS_OPERATION', reason: 'The map position itself is reported as wrong; fix that first.' });
  }
  const site = positionFlagged ? undefined : detectSiteContradiction(ctx, position.double, skipped);
  const findings = [
    ...detectPresence(ctx),
    ...position.findings,
    ...(site ? [site] : []),
    ...detectUnits(ctx),
    ...detectCrs(ctx),
    ...detectRotation(ctx),
    ...detectConsistency(ctx),
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const levels = georeferencingLevels(facts, ctx);
  const effectiveSource = ctx.operation?.source ?? (facts.siteLocation && !ctx.crs ? 'IfcSite' : undefined);
  return {
    level: levels.length ? levels[levels.length - 1] : 0,
    levels,
    effectiveSource,
    findings,
    skipped,
  };
}
