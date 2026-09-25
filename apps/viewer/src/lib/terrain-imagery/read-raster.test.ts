/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5942 — reading a raster and its sidecars into a placement, through real
 * files: a real PNG with a world file and `.prj`, and a real GeoTIFF written
 * by `geotiff` itself with its tags and GeoKeys. The refusals of spec §15.2
 * item 2 are asserted by their reasons.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeArrayBuffer } from 'geotiff';
import { GeoRasterBundle, isGeoRasterFile, resolveGeoRasterBundles } from './raster-bundle.js';
import { readGeoRasterBundle, webImageSize } from './read-raster.js';
import { crsFromWkt, wktFromAuxXml } from './georaster.js';
import { ORTHO, orthoPng, orthoRgba, orthoWorldFile } from './synthetic-orthophoto.fixture.js';

const LV95_WKT = 'PROJCS["CH1903+ / LV95",GEOGCS["CH1903+",DATUM["CH1903+",SPHEROID["Bessel 1841",6377397.155,299.1528128]],'
  + 'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Hotine_Oblique_Mercator_Azimuth_Center"],'
  + 'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","2056"]]';
const ESRI_WKT = 'PROJCS["CH1903+_LV95",GEOGCS["GCS_CH1903+",DATUM["D_CH1903+",SPHEROID["Bessel_1841",6377397.155,299.1528128]],'
  + 'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Hotine_Oblique_Mercator_Azimuth_Center"],UNIT["Meter",1.0]]';

function file(name: string, content: string | Uint8Array): File {
  return new File([typeof content === 'string' ? content : new Uint8Array(content)], name);
}

describe('raster bundles (#5942)', () => {
  it('pairs an image with its world file, .prj and .aux.xml, and leaves the terrain alone', () => {
    const terrain = file('terrain.xml', '<LandXML/>');
    const png = file('Ortho.png', orthoPng());
    const pgw = file('ortho.pgw', orthoWorldFile());
    const prj = file('ortho.prj', LV95_WKT);
    const aux = file('Ortho.png.aux.xml', '<PAMDataset/>');
    const { bundles, rest, orphans } = resolveGeoRasterBundles([png, terrain, pgw, prj, aux]);
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].image, png);
    assert.equal(bundles[0].worldFile, pgw);
    // The `.aux.xml` names the image exactly, so it is consulted before the stem-matched `.prj`.
    assert.deepEqual(bundles[0].crsFiles, [aux, prj]);
    // The `.aux.xml` ends in `.xml` but is NOT routed to the LandXML parser.
    assert.deepEqual(rest, [terrain]);
    assert.deepEqual(orphans, []);
    // A sidecar with no image beside it is reported, not routed as a model.
    assert.deepEqual(resolveGeoRasterBundles([terrain, file('other.pgw', orthoWorldFile())]).orphans.map((f) => f.name), ['other.pgw']);
  });

  it('leaves a PNG with no sidecar to the glTF route — alone it is far more often a texture', () => {
    const texture = file('texture.png', orthoPng());
    assert.equal(resolveGeoRasterBundles([file('scene.gltf', '{}'), texture]).bundles.length, 0);
    assert.equal(resolveGeoRasterBundles([texture]).bundles.length, 0);
    assert.equal(resolveGeoRasterBundles([texture, file('texture.pgw', orthoWorldFile())]).bundles.length, 1);
  });

  it('recognises the raster and sidecar extensions a picker must offer', () => {
    for (const name of ['a.tif', 'a.TIFF', 'a.tfw', 'a.pgw', 'a.jgw', 'a.wld', 'a.prj', 'a.png.aux.xml']) {
      assert.equal(isGeoRasterFile(file(name, '')), true, name);
    }
    assert.equal(isGeoRasterFile(file('a.ifc', '')), false);
  });
});

describe('reading a PNG + world file (#5942)', () => {
  it('reads the size from the header and the placement from the world file and .prj', async () => {
    const png = orthoPng();
    assert.deepEqual(webImageSize(png), { width: ORTHO.width, height: ORTHO.height, mime: 'image/png' });
    const bundle = new GeoRasterBundle(file('ortho.png', png), file('ortho.pgw', orthoWorldFile()), [file('ortho.prj', LV95_WKT)]);
    const read = await readGeoRasterBundle(bundle);
    assert.ok(read.ok, read.ok ? '' : read.reason);
    assert.equal(read.value.mime, 'image/png');
    assert.deepEqual(read.value.bytes, png);
    assert.equal(read.value.placement.crs, 'EPSG:2056');
    assert.equal(read.value.placement.placement, 'world file');
    assert.equal(read.value.placement.affine.c, ORTHO.upperLeftCorner[0]);
  });

  it('refuses a PNG with no world file, naming what is missing', async () => {
    const read = await readGeoRasterBundle(new GeoRasterBundle(file('ortho.png', orthoPng()), null, []));
    assert.equal(read.ok, false);
    assert.match(read.ok ? '' : read.reason, /no world file/);
  });

  it('leaves the CRS unknown for an ESRI .prj with no EPSG authority — never matched by name', async () => {
    assert.equal(crsFromWkt(ESRI_WKT), null);
    const bundle = new GeoRasterBundle(file('ortho.png', orthoPng()), file('ortho.pgw', orthoWorldFile()), [file('ortho.prj', ESRI_WKT)]);
    const read = await readGeoRasterBundle(bundle);
    assert.ok(read.ok);
    assert.equal(read.value.placement.crs, null);
  });

  it('reads the SRS of a GDAL .aux.xml', () => {
    const aux = `<PAMDataset><SRS dataAxisToSRSAxisMapping="1,2">${LV95_WKT.replace(/"/g, '&quot;')}</SRS></PAMDataset>`;
    assert.equal(crsFromWkt(wktFromAuxXml(aux) ?? ''), 'EPSG:2056');
  });
});

describe('reading a GeoTIFF (#5942)', () => {
  function geoTiff(rasterType: 1 | 2): Uint8Array {
    const rgba = orthoRgba();
    const rgb: number[] = [];
    for (let i = 0; i < rgba.length; i += 4) rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
    return new Uint8Array(writeArrayBuffer(rgb, {
      width: ORTHO.width, height: ORTHO.height,
      ModelPixelScale: [ORTHO.gsd, ORTHO.gsd, 0],
      // Under PixelIsPoint the tie point names the upper-left pixel's CENTRE.
      ModelTiepoint: rasterType === 1
        ? [0, 0, 0, ORTHO.upperLeftCorner[0], ORTHO.upperLeftCorner[1], 0]
        : [0, 0, 0, ORTHO.upperLeftCorner[0] + ORTHO.gsd / 2, ORTHO.upperLeftCorner[1] - ORTHO.gsd / 2, 0],
      GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: rasterType, ProjectedCSTypeGeoKey: 2056,
    }));
  }

  for (const rasterType of [1, 2] as const) {
    it(`reads the geotransform and EPSG code from the tags (${rasterType === 1 ? 'PixelIsArea' : 'PixelIsPoint'})`, async () => {
      const read = await readGeoRasterBundle(new GeoRasterBundle(file('ortho.tif', geoTiff(rasterType)), null, []));
      assert.ok(read.ok, read.ok ? '' : read.reason);
      const { placement } = read.value;
      assert.equal(placement.placement, 'GeoTIFF');
      assert.equal(placement.crs, 'EPSG:2056');
      assert.equal(placement.crsSource, 'GeoTIFF GeoKeys');
      assert.deepEqual([placement.width, placement.height], [ORTHO.width, ORTHO.height]);
      // Both encodings describe the same image: the corner lands on the same
      // spot once the raster type is honoured.
      assert.equal(placement.affine.c, ORTHO.upperLeftCorner[0]);
      assert.equal(placement.affine.f, ORTHO.upperLeftCorner[1]);
    });
  }
});
