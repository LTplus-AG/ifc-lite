/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectedCRS } from '@ifc-lite/parser';
import { reprojectFromLatLon, reprojectPointToLatLon, resolveProjection, type LatLon } from './reproject.js';
import { isGeographicProj4, projectedDefinitionInMetres } from './proj4-utils.js';
import { projectedUnitToMetres } from '../../hooks/ingest/projected-units.js';

/** Metres per degree of latitude; longitude is scaled by cos(lat). */
const M_PER_DEG = 111_320;
function offsetMetres(actual: LatLon, expected: LatLon): number {
  const dy = (actual.lat - expected.lat) * M_PER_DEG;
  const dx = (actual.lon - expected.lon) * M_PER_DEG * Math.cos((expected.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/**
 * The IfcWellKnownText shape of a real IFC4X3_ADD2 bridge export (labels,
 * origin and extent changed): a project-local Transverse Mercator on DB_REF
 * (Bessel) inside a COMPOUNDCRS, with WKT1-style PARAMETER names and no EPSG
 * code for the projected CRS itself. Unpatched, proj4's wkt-parser dropped
 * central_meridian/latitude_of_origin/scale_factor and put the bridge at 0°N 0°E.
 */
const DB_REF_LOCAL_TM = 'COMPOUNDCRS["LOCAL_TM_EXAMPLE",PROJCRS["Local TM",BASEGEOGCRS["DB_REF",DATUM["Deutsche Bahn Reference System",ELLIPSOID["Bessel 1841",6377397.155,299.1528128,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",5681]],CONVERSION["Local Projection",METHOD["Transverse_Mercator"],PARAMETER["central_meridian",10.4521,ANGLEUNIT["degree",0.0174532925199433,ID["EPSG",9122]]],PARAMETER["latitude_of_origin",51.2763,ANGLEUNIT["degree",0.0174532925199433,ID["EPSG",9122]]],PARAMETER["scale_factor",1.0000124,SCALEUNIT["unity",1,ID["EPSG",9201]]],PARAMETER["false_easting",20000,LENGTHUNIT["metre",1,ID["EPSG",9001]]],PARAMETER["false_northing",30000,LENGTHUNIT["metre",1,ID["EPSG",9001]]]],CS[Cartesian,2],AXIS["e",east,ORDER[1],LENGTHUNIT["metre",1,ID["EPSG",9001]]],AXIS["n",north,ORDER[2],LENGTHUNIT["metre",1,ID["EPSG",9001]]]],VERTCRS["GNTRANS2016 height",VDATUM["GNTRANS2016"],CS[vertical,1],AXIS["gravity-related height",up,LENGTHUNIT["metre",1]],ID["EPSG",9927]],USAGE[SCOPE["Engineering survey"],AREA["Example area"],BBOX[51.18,10.30,51.37,10.60]]]';

/** Expected values are PROJ 9 (pyproj) output for the same WKT — the ground truth, not proj4's. */
const crs = (wellKnownText: string, name = 'WKT'): ProjectedCRS => ({ id: 1, name, wellKnownText, mapUnitScale: 1 });

describe('IfcWellKnownText projections', () => {
  it('places the DB_REF local TM bridge where PROJ does', async () => {
    for (const [x, y, expected] of [
      [20000, 30000, { lon: 10.450830563665846, lat: 51.275017141839164 }],
      [20500, 30300, { lon: 10.457996045430294, lat: 51.27771347390945 }],
    ] as const) {
      const result = await reprojectPointToLatLon(x, y, crs(DB_REF_LOCAL_TM));
      assert.ok(result, `(${x}, ${y}) did not resolve`);
      const offset = offsetMetres(result, expected);
      assert.ok(offset < 0.05, `(${x}, ${y}) lands ${offset.toFixed(3)} m off (${result.lat}, ${result.lon})`);
    }
  });

  it('round-trips through the registered definition and reports it as projected metres', async () => {
    const definition = await resolveProjection(crs(DB_REF_LOCAL_TM));
    assert.ok(definition);
    assert.equal(isGeographicProj4(definition), false);
    assert.equal(projectedUnitToMetres(definition), 1);
    assert.equal(projectedUnitToMetres(projectedDefinitionInMetres(definition)), 1);
    const back = await reprojectFromLatLon({ lon: 10.457996045430294, lat: 51.27771347390945 }, crs(DB_REF_LOCAL_TM));
    assert.ok(back);
    assert.ok(Math.abs(back.easting - 20500) < 0.01 && Math.abs(back.northing - 30300) < 0.01, JSON.stringify(back));
  });

  it('reads WKT1 with an explicit TOWGS84', async () => {
    const wkt1 = 'PROJCS["DHDN GK4 custom",GEOGCS["DHDN",DATUM["Deutsches_Hauptdreiecksnetz",SPHEROID["Bessel 1841",6377397.155,299.1528128],TOWGS84[598.1,73.7,418.2,0.202,0.045,-2.455,6.7]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",12],PARAMETER["scale_factor",1],PARAMETER["false_easting",4500000],PARAMETER["false_northing",0],UNIT["metre",1]]';
    const result = await reprojectPointToLatLon(4590000, 5820000, crs(wkt1));
    assert.ok(result);
    const offset = offsetMetres(result, { lon: 13.323955808459164, lat: 52.50572528078191 });
    assert.ok(offset < 0.05, `lands ${offset.toFixed(3)} m off`);
  });

  it('reads WKT2 with EPSG parameter names and no identifier', async () => {
    const wkt2 = 'PROJCRS["ETRS89 / UTM zone 32N",BASEGEOGCRS["ETRS89",DATUM["European Terrestrial Reference System 1989",ELLIPSOID["GRS 1980",6378137,298.257222101]]],CONVERSION["UTM zone 32N",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Longitude of natural origin",9,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],CS[Cartesian,2],AXIS["(E)",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["(N)",north,ORDER[2],LENGTHUNIT["metre",1]]]';
    const result = await reprojectPointToLatLon(690000, 5335000, crs(wkt2));
    assert.ok(result);
    const offset = offsetMetres(result, { lon: 11.55407270413273, lat: 48.13985773317233 });
    assert.ok(offset < 0.05, `lands ${offset.toFixed(3)} m off`);
  });

  it('prefers the EPSG identifier a WKT names over re-deriving it, and the WKT over the name', async () => {
    const identified = await resolveProjection(crs('PROJCRS["ETRS89 / UTM zone 33N",ID["EPSG",25833]]', 'EPSG:25832'));
    assert.equal(identified, await resolveProjection({ id: 2, name: 'EPSG:25833' }));
  });

  it('falls back to the name when the WKT cannot be read', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(
        await resolveProjection(crs('VERTCRS["height only"]', 'EPSG:25832')),
        await resolveProjection({ id: 2, name: 'EPSG:25832' }),
      );
      assert.equal(await resolveProjection(crs('not wkt at all', 'WKT')), null);
    } finally {
      console.warn = warn;
    }
  });

  it('treats a geographic WKT as geographic', async () => {
    const definition = await resolveProjection(crs('GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563]],CS[ellipsoidal,2],AXIS["latitude",north],AXIS["longitude",east],ANGLEUNIT["degree",0.0174532925199433]]'));
    assert.ok(definition);
    assert.equal(isGeographicProj4(definition), true);
  });

  it('refuses a position outside the extent the WKT declares', async () => {
    // Same definition with a BBOX on the other side of Germany.
    const elsewhere = DB_REF_LOCAL_TM.replace('BBOX[51.18,10.30,51.37,10.60]', 'BBOX[47.5,7.5,48.0,8.0]');
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => { warnings.push(message); };
    try {
      assert.equal(await reprojectPointToLatLon(20000, 30000, crs(elsewhere)), null);
    } finally {
      console.warn = warn;
    }
    assert.ok(warnings.some((message) => message.includes('outside the extent')), warnings.join('\n'));
  });
});
