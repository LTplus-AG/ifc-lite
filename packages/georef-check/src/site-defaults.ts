/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IfcSite reference points that are known to be left behind by authoring
 * tools rather than set by a person. A list, not a heuristic: a site lands in
 * it only with evidence, so a real project near one of these is a rare false
 * alarm, and the finding's wording says how to dismiss it.
 */

export interface KnownSiteDefault {
  label: string;
  latitude: number;
  longitude: number;
  /** Why this point is on the list. */
  evidence: string;
}

export const KNOWN_SITE_DEFAULTS: readonly KnownSiteDefault[] = [
  {
    label: 'Boston, MA (Revit default project location)',
    latitude: 42.3584,
    longitude: -71.0598,
    evidence: 'Autodesk Revit templates set the project location to Boston, MA until it is changed.',
  },
  {
    label: '42°24\'53"N 71°15\'29"W (near Boston, MA; a Revit export default)',
    latitude: 42.414864,
    longitude: -71.258072,
    evidence: 'Written as (42,24,53,508911) / (-71,-15,-29,-58837) on an IfcSite named "Default" by two Revit exports in this '
      + "repository's fixtures: tests/models/various/rvt01.ifc (Autodesk Revit 24.0.5.432, IFC exporter 24.2.0.49) and "
      + 'rust/geometry/tests/fixtures/issue_098_wall_W.ifc (Revit IFC exporter 22.0.2.392).',
  },
];

/**
 * 0.01° is about 1.1 km of latitude: defaults are written verbatim (or
 * rounded to seconds), so a match is either exact or the site was really set.
 */
export const SITE_DEFAULT_TOLERANCE_DEGREES = 0.01;

/**
 * "Null Island": 0°N 0°E is in the Gulf of Guinea. 0.001° (about 110 m) is
 * enough to catch 0/0 written with rounding noise.
 */
export const NULL_ISLAND_TOLERANCE_DEGREES = 0.001;

export function matchSiteDefault(latitude: number, longitude: number): KnownSiteDefault | 'nullIsland' | undefined {
  if (Math.abs(latitude) <= NULL_ISLAND_TOLERANCE_DEGREES && Math.abs(longitude) <= NULL_ISLAND_TOLERANCE_DEGREES) {
    return 'nullIsland';
  }
  return KNOWN_SITE_DEFAULTS.find((d) =>
    Math.abs(d.latitude - latitude) <= SITE_DEFAULT_TOLERANCE_DEGREES
    && Math.abs(d.longitude - longitude) <= SITE_DEFAULT_TOLERANCE_DEGREES);
}

/** Great-circle distance in kilometres (spherical, R = 6371 km; ample for a 10 km threshold). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
