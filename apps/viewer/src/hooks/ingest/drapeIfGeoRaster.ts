/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GeoRasterBundle } from '@/lib/terrain-imagery/raster-bundle.js';
import { settleUnownedLoadUi } from '../modelLoadCanceller.js';

/**
 * #5942: a georeferenced raster bundle is imagery for the loaded terrain, not
 * a model. It enters `useIfcLoader.loadFile` like every source, and this
 * returns the drape before `loadFile` bumps the load session or resets the
 * scene; `null` for anything else. Kept apart from `terrainImageryDrape.ts`
 * so that module, and the raster reader behind it, load only when used.
 *
 * The drape installs no canceller, so when it settles it ends only load UI
 * that no streaming load owns.
 */
export function drapeIfGeoRaster(file: File): Promise<void> | null {
  if (!(file instanceof GeoRasterBundle)) return null;
  return import('./terrainImageryDrape.js')
    .then(({ drapeGeoRasterBundle }) => drapeGeoRasterBundle(file))
    .finally(settleUnownedLoadUi);
}
