/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How the viewer scales a model's geometry onto the map, so a merge can keep it (#10886). A copy of
 * `getEffectiveAxisScales` (`apps/viewer/src/lib/geo/geo-scale.ts`), which export cannot import;
 * `merged-exporter.georef-normalize.test.ts` checks it against that file.
 */

import type { MapConversion } from '@ifc-lite/parser';

/** The viewer's tolerance for a Factor that bridges the units (`geo-scale.ts` `NEAR_UNITY`). */
const NEAR_UNITY = 0.005;

/** A map unit in metres as the viewer reads it: a missing or unread one is a metre (`@ifc-lite/geo` `map-unit.ts`). */
export const viewerMapUnitScale = (mapUnitScale: number | undefined): number => (mapUnitScale && mapUnitScale > 0 ? mapUnitScale : 1);

/**
 * The viewer's x, y, z scale for a conversion's geometry in a project of length unit `projectScale`: Scale × Factor ×
 * map unit / project unit, or the Factors alone when Scale is unset or 1, the units differ and no Factor bridges them.
 */
export function viewerAxisScales(conversion: Pick<MapConversion, 'scale' | 'factorX' | 'factorY' | 'factorZ'>,
  mapUnitScale: number | undefined, projectScale: number): number[] {
  const mus = viewerMapUnitScale(mapUnitScale), lus = projectScale > 0 ? projectScale : 1;
  const factors = [conversion.factorX, conversion.factorY, conversion.factorZ];
  const spec = factors.map(factor => ((conversion.scale ?? 1) * (factor ?? 1) * mus) / lus);
  const scaleUnset = !(conversion.scale != null && Math.abs(conversion.scale - 1) > 1e-9);
  const factorBridges = factors.some((factor, axis) => factor !== undefined && Math.abs(spec[axis] - 1) <= NEAR_UNITY);
  return !scaleUnset || Math.abs(mus - lus) <= 1e-9 || factorBridges ? spec : factors.map(factor => factor ?? 1);
}
