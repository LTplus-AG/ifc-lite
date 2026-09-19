/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLandXmlViewerModel } from './landXmlViewerModel.js';
import { parseLandXmlTin } from './landXmlTin.js';

const LANDXML = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units>
    <Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter"
      temperatureUnit="celsius" pressureUnit="milliBars" elevationUnit="meter"/>
  </Units>
  <Surfaces>
    <Surface name="Existing Ground">
      <Definition surfType="TIN">
        <Pnts>
          <P id="10">5000000 2600000 100</P>
          <P id="20">5000000 2600010 100</P>
          <P id="30">5000010 2600000 102</P>
          <P id="40">5000010 2600010 102</P>
        </Pnts>
        <Faces>
          <F>10 20 30</F>
          <F i="1">20 40 30</F>
        </Faces>
      </Definition>
    </Surface>
    <Surface name="Unsupported Grid">
      <Definition surfType="grid">
        <Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts>
        <Faces><F>1 2 3 1</F></Faces>
      </Definition>
    </Surface>
  </Surfaces>
</LandXML>`;

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function utf16LeBytes(text: string): ArrayBuffer {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set([0xff, 0xfe]);
  for (let i = 0; i < text.length; i++) {
    const codeUnit = text.charCodeAt(i);
    bytes[2 + i * 2] = codeUnit & 0xff;
    bytes[3 + i * 2] = codeUnit >>> 8;
  }
  return bytes.buffer;
}

describe('LandXML 1.2 TIN ingest (#4937)', () => {
  it('parses schema point order and ignores invisible/non-TIN faces', () => {
    const parsed = parseLandXmlTin(LANDXML);
    assert.equal(parsed.version, '1.2');
    assert.equal(parsed.surfaces.length, 1);
    assert.equal(parsed.surfaces[0].name, 'Existing Ground');
    assert.deepEqual(parsed.surfaces[0].points[0], {
      id: '10', northing: 5_000_000, easting: 2_600_000, elevation: 100,
    });
    assert.deepEqual(parsed.surfaces[0].faces, [['10', '20', '30']]);
    assert.match(parsed.warnings[0], /Unsupported Grid/);
  });

  it('produces a rebased Y-up render mesh without losing survey coordinates', () => {
    const result = parseLandXmlViewerModel(bytes(LANDXML));
    assert.equal(result.geometryResult.meshes.length, 1);
    assert.equal(result.geometryResult.totalTriangles, 1);
    assert.equal(result.geometryResult.totalVertices, 3);
    assert.deepEqual(result.surfaceNames, ['Existing Ground']);

    const mesh = result.geometryResult.meshes[0];
    assert.deepEqual(mesh.origin, [2_600_005, 101, -5_000_005]);
    assert.deepEqual(Array.from(mesh.positions.slice(0, 9)), [
      -5, -1, 5,
      5, -1, 5,
      -5, 1, -5,
    ]);
    assert.deepEqual(Array.from(mesh.indices), [0, 1, 2]);
    assert.ok(mesh.normals[1] > 0, 'terrain normal must face viewer-up');
    assert.equal(result.geometryResult.coordinateInfo.hasLargeCoordinates, true);
    assert.equal(result.geometryResult.coordinateInfo.originalBounds.min.x, 2_600_000);
    assert.equal(result.geometryResult.coordinateInfo.originalBounds.max.z, -5_000_000);
  });

  it('excludes points unused by visible faces from vertex and camera bounds', () => {
    const withOutlier = LANDXML.replace(
      '</Pnts>',
      '<P id="99">900000000 800000000 700000000</P></Pnts>',
    );
    const result = parseLandXmlViewerModel(bytes(withOutlier));
    assert.equal(result.geometryResult.totalVertices, 3);
    assert.deepEqual(result.geometryResult.meshes[0].origin, [2_600_005, 101, -5_000_005]);
    assert.equal(result.geometryResult.coordinateInfo.originalBounds.max.x, 2_600_010);
  });

  it('excludes distant points referenced only by a rejected degenerate face', () => {
    const withDegenerateOutlier = LANDXML
      .replace(
        '</Pnts>',
        `<P id="50">900000000 800000000 700000000</P>
         <P id="51">900000001 800000001 700000001</P>
         <P id="52">900000002 800000002 700000002</P></Pnts>`,
      )
      .replace('</Faces>', '<F>50 51 52</F></Faces>');
    const result = parseLandXmlViewerModel(bytes(withDegenerateOutlier));
    assert.equal(result.geometryResult.totalVertices, 3);
    assert.equal(result.geometryResult.totalTriangles, 1);
    assert.deepEqual(result.geometryResult.meshes[0].origin, [2_600_005, 101, -5_000_005]);
    assert.ok(result.warnings.some((warning) => /Skipped 1 degenerate face/.test(warning)));
  });

  it('decodes XML-required UTF-16 input before parsing', () => {
    const utf16 = LANDXML.replace('encoding="UTF-8"', 'encoding="UTF-16"');
    const result = parseLandXmlViewerModel(utf16LeBytes(utf16));
    assert.equal(result.geometryResult.totalTriangles, 1);
    assert.deepEqual(result.surfaceNames, ['Existing Ground']);
  });

  it('applies the declared horizontal and elevation units independently', () => {
    const imperial = LANDXML
      .replace('<Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter"\n      temperatureUnit="celsius" pressureUnit="milliBars" elevationUnit="meter"/>',
        '<Imperial areaUnit="squareFoot" linearUnit="USSurveyFoot" volumeUnit="cubicFeet" temperatureUnit="fahrenheit" pressureUnit="inchHG" elevationUnit="feet"/>')
      .replaceAll('5000000', '0').replaceAll('2600000', '0').replaceAll('2600010', '10')
      .replaceAll('5000010', '10');
    const result = parseLandXmlViewerModel(bytes(imperial));
    const info = result.geometryResult.coordinateInfo.originalBounds;
    assert.ok(Math.abs(info.max.x - (10 * 1200 / 3937)) < 1e-6);
    assert.ok(Math.abs(info.max.y - (102 * 0.3048)) < 1e-5);
  });

  it('rejects a face whose point identity cannot be resolved', () => {
    assert.throws(
      () => parseLandXmlTin(LANDXML.replace('<F>10 20 30</F>', '<F>10 20 999</F>')),
      /unknown point 999/,
    );
  });

  it('resolves positive-integer point ids by XML Schema value, not spelling', () => {
    const parsed = parseLandXmlTin(LANDXML
      .replace('<P id="10">', '<P id="+0010">')
      .replace('<F>10 20 30</F>', '<F>00010 +20 030</F>'));
    assert.equal(parsed.surfaces[0].points[0].id, '10');
    assert.deepEqual(parsed.surfaces[0].faces, [['10', '20', '30']]);
  });

  it('ignores extension elements that reuse LandXML local names', () => {
    const withExtensionSurface = LANDXML.replace(
      '</Surfaces>',
      `<ext:Surface xmlns:ext="urn:vendor-extension" name="Not terrain">
        <ext:Definition surfType="TIN"/>
      </ext:Surface></Surfaces>`,
    );
    const parsed = parseLandXmlTin(withExtensionSurface);
    assert.deepEqual(parsed.surfaces.map((surface) => surface.name), ['Existing Ground']);
  });

  it('rejects a non-LandXML namespace even when the root spoofs version 1.2', () => {
    assert.throws(
      () => parseLandXmlTin(LANDXML.replace(
        'http://www.landxml.org/schema/LandXML-1.2',
        'urn:not-landxml',
      )),
      /Unsupported LandXML namespace/,
    );
  });

  it('rejects a LandXML 1.1 namespace even when the version attribute says 1.2', () => {
    assert.throws(
      () => parseLandXmlTin(LANDXML.replace(
        'http://www.landxml.org/schema/LandXML-1.2',
        'http://www.landxml.org/schema/LandXML-1.1',
      )),
      /Unsupported LandXML namespace/,
    );
  });

  it('requires the exact LandXML 1.2 namespace', () => {
    assert.throws(
      () => parseLandXmlTin(LANDXML.replace(
        'http://www.landxml.org/schema/LandXML-1.2',
        'urn:vendor:LandXML-1.2',
      )),
      /Unsupported LandXML namespace/,
    );
    assert.throws(
      () => parseLandXmlTin(LANDXML.replace(
        ' xmlns="http://www.landxml.org/schema/LandXML-1.2"',
        '',
      )),
      /Unsupported LandXML namespace: missing/,
    );
  });

  it('parses without the window-only DOMParser global used by the browser main thread', () => {
    assert.equal(globalThis.DOMParser, undefined);
    assert.equal(parseLandXmlTin(LANDXML).surfaces[0].name, 'Existing Ground');
  });
});
