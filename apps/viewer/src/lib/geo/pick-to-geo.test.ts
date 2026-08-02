/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  hasUsableMapGeoref,
  viewerPointToProjected,
  type MapGeoreference,
} from './pick-to-geo.js';
import type { EffectiveGeoreference } from './effective-georef.js';

/**
 * Ground truth from the bundled `apps/viewer/public/samples/building-architecture.ifc`:
 *   #19 = IFCMAPCONVERSION(#11, #18, 729013348.8297004, 9063992684.697363,
 *                          1300.0000000000011, 0.4999999999999999,
 *                          0.8660254037844387, 1.);
 *   #18 = IFCPROJECTEDCRS('EPSG:32760', ..., MapUnit = #15 = MILLIMETRE);
 *   project length unit = MILLIMETRE.
 *
 * XAxisAbscissa 0.5 / XAxisOrdinate 0.866 encode a 60 deg grid rotation, and
 * BOTH the offsets and the project geometry are millimetre-scaled
 * (mapUnitScale = lengthUnitScale = 0.001). The readout must therefore honour
 * the map-unit scale: the offsets are stored in millimetres even though
 * EPSG:32760 is a metre CRS. Using the parser's `transformToWorld` (which
 * assumes map units) here would be ~1000x wrong.
 */
const BUILDING_ARCH_EASTINGS = 729013348.8297004;
const BUILDING_ARCH_NORTHINGS = 9063992684.697363;
const BUILDING_ARCH_ORTHO_HEIGHT = 1300.0000000000011;
const BUILDING_ARCH_ABSCISSA = 0.4999999999999999; // cos 60 deg
const BUILDING_ARCH_ORDINATE = 0.8660254037844387; // sin 60 deg

function buildingArchGeoref(): MapGeoreference {
  return {
    hasGeoreference: true,
    source: 'mapConversion',
    projectedCRS: { id: 18, name: 'EPSG:32760', mapUnit: 'MILLIMETRE', mapUnitScale: 0.001 },
    mapConversion: {
      id: 19,
      sourceCRS: 11,
      targetCRS: 18,
      eastings: BUILDING_ARCH_EASTINGS,
      northings: BUILDING_ARCH_NORTHINGS,
      orthogonalHeight: BUILDING_ARCH_ORTHO_HEIGHT,
      xAxisAbscissa: BUILDING_ARCH_ABSCISSA,
      xAxisOrdinate: BUILDING_ARCH_ORDINATE,
      scale: 1,
    },
    lengthUnitScale: 0.001,
  };
}

/** A no-rotation georef in a genuine metre CRS (offsets already in metres). */
function metreCrsGeoref(): MapGeoreference {
  return {
    hasGeoreference: true,
    source: 'mapConversion',
    projectedCRS: { id: 1, name: 'EPSG:32631', mapUnit: 'METRE', mapUnitScale: 1 },
    mapConversion: {
      id: 2,
      sourceCRS: 10,
      targetCRS: 1,
      eastings: 500000,
      northings: 5000000,
      orthogonalHeight: 100,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      scale: 1,
    },
    lengthUnitScale: 1,
  };
}

describe('viewerPointToProjected', () => {
  it('maps the IFC origin exactly to the authored MapConversion values (mm-scaled sample)', () => {
    const eff = buildingArchGeoref();
    // Origin can sit anywhere in viewer-local space; picking it back yields a
    // zero delta and thus the raw authored offsets, mm and all.
    const originViewer = { x: 12.5, y: -4, z: 7 };
    const out = viewerPointToProjected(originViewer, eff, originViewer);

    assert.strictEqual(out.eastings, BUILDING_ARCH_EASTINGS);
    assert.strictEqual(out.northings, BUILDING_ARCH_NORTHINGS);
    assert.strictEqual(out.height, BUILDING_ARCH_ORTHO_HEIGHT);
    assert.strictEqual(out.crsName, 'EPSG:32760');
  });

  it('rotates a 1 m viewer-X step by the 60 deg grid and scales it to millimetres', () => {
    const eff = buildingArchGeoref();
    const originViewer = { x: 12.5, y: -4, z: 7 };
    // 1 metre along viewer +X.
    const point = { x: originViewer.x + 1, y: originViewer.y, z: originViewer.z };
    const out = viewerPointToProjected(point, eff, originViewer);

    // 1 m along viewer-X projects onto (cos60, sin60) = (0.5 m, 0.866 m) in the
    // grid, i.e. +500 mm easting / +866.025 mm northing in the mm map unit.
    assert.ok(
      Math.abs(out.eastings - (BUILDING_ARCH_EASTINGS + 500)) < 1e-3,
      `eastings = ${out.eastings}`,
    );
    assert.ok(
      Math.abs(out.northings - (BUILDING_ARCH_NORTHINGS + 866.0254037844387)) < 1e-3,
      `northings = ${out.northings}`,
    );
    // No vertical move.
    assert.ok(Math.abs(out.height - BUILDING_ARCH_ORTHO_HEIGHT) < 1e-6, `height = ${out.height}`);
  });

  it('adds a 1 m viewer-Y rise as +1000 mm orthogonal height (map-unit scaled)', () => {
    const eff = buildingArchGeoref();
    const originViewer = { x: 0, y: 0, z: 0 };
    const out = viewerPointToProjected({ x: 0, y: 1, z: 0 }, eff, originViewer);
    // Height is the authored orthogonal height + the metre rise in map units.
    assert.ok(
      Math.abs(out.height - (BUILDING_ARCH_ORTHO_HEIGHT + 1000)) < 1e-6,
      `height = ${out.height}`,
    );
    // Purely vertical: E/N unchanged.
    assert.ok(Math.abs(out.eastings - BUILDING_ARCH_EASTINGS) < 1e-6);
    assert.ok(Math.abs(out.northings - BUILDING_ARCH_NORTHINGS) < 1e-6);
  });

  it('handles a no-rotation metre CRS with the local_to_map sign convention', () => {
    const eff = metreCrsGeoref();
    const originViewer = { x: 0, y: 0, z: 0 };
    // Viewer +X -> +Easting; viewer -Z -> +Northing (viewer Z = -ifcY); +Y -> +H.
    const out = viewerPointToProjected({ x: 3, y: 2, z: -4 }, eff, originViewer);
    assert.strictEqual(out.eastings, 500003);
    assert.strictEqual(out.northings, 5000004);
    assert.strictEqual(out.height, 102);
    assert.strictEqual(out.crsName, 'EPSG:32631');
  });

  it('offsets from a non-zero anchor origin (federated frame)', () => {
    const eff = metreCrsGeoref();
    const originViewer = { x: 10, y: 5, z: -20 };
    const out = viewerPointToProjected({ x: 13, y: 7, z: -24 }, eff, originViewer);
    // Delta = (3, 2, -4), identical to the previous case.
    assert.strictEqual(out.eastings, 500003);
    assert.strictEqual(out.northings, 5000004);
    assert.strictEqual(out.height, 102);
  });
});

describe('hasUsableMapGeoref', () => {
  it('accepts a projected-CRS map conversion', () => {
    assert.strictEqual(hasUsableMapGeoref(buildingArchGeoref()), true);
  });

  it('rejects null / undefined', () => {
    assert.strictEqual(hasUsableMapGeoref(null), false);
    assert.strictEqual(hasUsableMapGeoref(undefined), false);
  });

  it('rejects a bare IfcSite lat/lon (source === siteLocation)', () => {
    const siteOnly: EffectiveGeoreference = {
      ...buildingArchGeoref(),
      source: 'siteLocation',
    };
    assert.strictEqual(hasUsableMapGeoref(siteOnly), false);
  });

  it('rejects a georef missing the projected CRS name', () => {
    const noCrsName: EffectiveGeoreference = {
      ...buildingArchGeoref(),
      projectedCRS: { id: 0, name: '', mapUnit: 'METRE', mapUnitScale: 1 },
    };
    assert.strictEqual(hasUsableMapGeoref(noCrsName), false);
  });

  it('rejects a georef missing the map conversion', () => {
    const noConversion: EffectiveGeoreference = {
      ...buildingArchGeoref(),
      mapConversion: undefined,
    };
    assert.strictEqual(hasUsableMapGeoref(noConversion), false);
  });
});
