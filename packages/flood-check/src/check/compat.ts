/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Whether the model facts, the hazard raster and the terrain describe the same ground. */

import { FloodCheckRefusal } from '../errors.js';
import { normalizeCrs, sameCrs, verticalCrsIdentifier } from '../crs.js';
import type { ModelFacts } from '../model/facts.js';

/** Refuse when the facts, raster and terrain do not share a CRS and (where the model states one) a vertical CRS. */
export function assertCompatible(facts: ModelFacts, rasterCrs: string, terrain: { crs: string; verticalCrs: string }): void {
  const crs = facts.georeference.crs;
  if (!sameCrs(crs, rasterCrs)) {
    throw new FloodCheckRefusal('crs-mismatch', `the model is in ${crs}; the hazard map is in ${rasterCrs}`);
  }
  if (!sameCrs(crs, terrain.crs)) {
    throw new FloodCheckRefusal('crs-mismatch', `the model is in ${crs}; the terrain is in ${terrain.crs}`);
  }
  const terrainVertical = normalizeCrs(terrain.verticalCrs);
  if (!terrainVertical) {
    throw new FloodCheckRefusal(
      'vertical-datum-unrecognised',
      `the terrain's verticalCrs "${terrain.verticalCrs}" is not an EPSG identifier (for example EPSG:5728 for LN02)`,
    );
  }
  const stated = facts.georeference.verticalDatum;
  if (!stated) return;
  const modelVertical = verticalCrsIdentifier(stated);
  if (!modelVertical) {
    throw new FloodCheckRefusal(
      'vertical-datum-unrecognised',
      `the model states vertical datum "${stated}", which names no known vertical CRS; it cannot be compared with the terrain's ${terrainVertical}`,
    );
  }
  if (modelVertical !== terrainVertical) {
    throw new FloodCheckRefusal(
      'vertical-datum-mismatch',
      `the model states vertical datum "${stated}" (${modelVertical}); the terrain is in ${terrainVertical}`,
    );
  }
}
