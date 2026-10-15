/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * proj4 definitions that replace what epsg.io returns, applied by
 * generate-epsg-index.ts after every fetch. Each entry fixes a known-bad
 * epsg.io string (wrong Helmert rotation convention or a missing +towgs84;
 * see the doc block above fetchProj4Definitions there), so a regeneration
 * cannot silently bring the error back. Add a control point
 * (packages/data/scripts/fixtures/epsg-control-points.json), a viewer
 * reprojection test, or (geocentric/3D) a case in
 * packages/data/scripts/proj4-overrides.test.ts with any new override.
 *
 * If a regeneration changes the +towgs84 signs or presence of any CRS with a
 * control point, re-verify against the EPSG Registry CoordOperation method
 * before accepting it: that is how every entry below was found.
 */

/** EPSG:5826 "DB_REF to ETRS89 (1)" (method 9607) negated to Position Vector (#7658). */
const DB_REF_TOWGS84 = '+towgs84=584.9636,107.7175,413.8067,1.1155,0.2824,-3.1384,7.9922';

/** [projected, DB_REF2003 compound, DB_REF2016 compound, 3-degree Gauss-Kruger zone] */
const DB_REF_ZONES: ReadonlyArray<readonly [string, string, string, number]> = [
  ['5682', '9928', '9932', 2],
  ['5683', '9929', '9933', 3],
  ['5684', '9930', '9934', 4],
  ['5685', '9931', '9935', 5],
];

function dbRefOverrides(): Array<[string, string]> {
  const geographic = `+proj=longlat +ellps=bessel ${DB_REF_TOWGS84} +no_defs +type=crs`;
  const overrides: Array<[string, string]> = [
    ['5681', geographic],
    ['5830', geographic],
    ['5828', `+proj=geocent +ellps=bessel ${DB_REF_TOWGS84} +units=m +no_defs +type=crs`],
  ];
  for (const [projected, dbRef2003, dbRef2016, zone] of DB_REF_ZONES) {
    const tmerc = `+proj=tmerc +lat_0=0 +lon_0=${zone * 3} +k=1 +x_0=${zone * 1_000_000 + 500_000} +y_0=0 +ellps=bessel ${DB_REF_TOWGS84} +units=m`;
    const compound = `${tmerc} +vunits=m +no_defs +type=crs`;
    overrides.push([projected, `${tmerc} +no_defs +type=crs`], [dbRef2003, compound], [dbRef2016, compound]);
  }
  return overrides;
}

export const PROJ4_OVERRIDES: ReadonlyMap<string, string> = new Map([
  // #2904: Belgian Lambert 72, EPSG:1652 Position Vector signs.
  ['31370', '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs +type=crs'],
  // #2904: Sweden RT90, EPSG:1896 (method 9607) negated.
  ['3021', '+proj=tmerc +lat_0=0 +lon_0=15.8082777777778 +k=1 +x_0=1500000 +y_0=0 +ellps=bessel +towgs84=414.1,41.3,603.1,-0.855,2.141,-7.023,0 +units=m +no_defs +type=crs'],
  // #2904: S-JTSK (Ferro) / Krovak, EPSG:5239 (method 9607) negated; epsg.io sometimes omits it.
  ['2065', '+proj=krovak +axis=swu +lat_0=49.5 +lon_0=42.5 +alpha=30.2881397527778 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +pm=ferro +towgs84=572.213,85.334,461.94,4.9732,1.529,5.2484,3.5378 +units=m +no_defs +type=crs'],
  ...dbRefOverrides(),
]);

/**
 * Replace incoming proj4 strings with PROJ4_OVERRIDES and report, per code,
 * whether the override changed the incoming value, matched it, or found no entry.
 */
export function applyProj4Overrides(entries: Array<{ code: string; proj4?: string }>): void {
  const byCode = new Map(entries.map((entry) => [entry.code, entry]));
  const changed: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  for (const [code, proj4] of PROJ4_OVERRIDES) {
    const entry = byCode.get(code);
    if (!entry) { missing.push(code); continue; }
    (entry.proj4 === proj4 ? unchanged : changed).push(code);
    entry.proj4 = proj4;
  }
  console.error(`proj4 overrides: changed ${changed.join(',') || '-'}; unchanged ${unchanged.join(',') || '-'}; not in index ${missing.join(',') || '-'}`);
}
