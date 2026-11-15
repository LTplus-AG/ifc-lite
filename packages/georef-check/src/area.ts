/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Tests against an EPSG area of use, shared by every detector that uses one. */

import type { CrsCatalogEntry } from './types.js';

/**
 * Margin around an EPSG area of use. EPSG draws the area along borders and
 * coastlines; a site on the border, or a project just across it that keeps
 * the national grid (customary for a few tens of kilometres), must not be
 * called outside. 0.5° is 35-55 km at building latitudes: generous for that,
 * and still far below every slip it is meant to catch (a swapped axis, a
 * factor of 1000, a wrong country), each of which is hundreds of kilometres
 * or more.
 */
export const AREA_OF_USE_MARGIN_DEGREES = 0.5;

export function insideAreaOfUse(area: NonNullable<CrsCatalogEntry['areaOfUse']>, latitude: number, longitude: number): boolean {
  const m = AREA_OF_USE_MARGIN_DEGREES;
  if (!(latitude >= area.south - m && latitude <= area.north + m)) return false;
  // An area crossing the antimeridian is written west > east (west 170, east -170): inside is east of west OR west of east.
  if (area.west > area.east) return longitude >= area.west - m || longitude <= area.east + m;
  return longitude >= area.west - m && longitude <= area.east + m;
}
