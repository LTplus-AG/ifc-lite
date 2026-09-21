/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ModelSpatialReference } from '@ifc-lite/geometry';
import { applyLandXmlRenderedLineUpdates, buildLandXmlRenderedLineUpdates } from './landXmlSpatialLines.js';
import type { LandXmlTinDocument } from './landXmlSemantics.js';

function reference(
  eastings: number, northings: number, height: number, horizontal = 'EPSG:2056',
): ModelSpatialReference {
  return {
    source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
    horizontal: { id: horizontal, provenance: { source: 'test' } },
    vertical: { id: 'EPSG:5729', provenance: { source: 'test' } },
    localToProjected: {
      kind: 'local-projected-affine', eastings, northings, orthogonalHeight: height,
      xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    confidence: 'declared',
  };
}

function document(): LandXmlTinDocument {
  return {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: true, preservedOnlySurfaces: 0, unknownExtensions: 0 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1 },
    surfaces: [{
      sourceId: 'surface', ordinal: 1, sourcePath: 'LandXML/Surfaces/Surface[1]', properties: {},
      definitionProperties: {}, name: 'survey', kind: 'tin', renderState: 'rendered', points: [],
      sourceDataPoints: [], faces: [], faceSourceIds: [], faceVisibility: [], hiddenFaceCount: 0,
      boundaries: [], contours: [], breaklines: [{
        sourceId: 'line', ordinal: 1, name: null, kind: 'breakline',
        sourcePath: 'LandXML/Surfaces/Surface[1]/Breakline', properties: {}, coordinateDimension: 3,
        points: [[2003, 1002, 24]], pointSourceIds: [],
      }],
    }],
    extensions: [], warnings: [], rendering: { meshProvenance: [], surfaceCounts: [] },
  };
}

describe('LandXML federated overlay coordinates (#5048)', () => {
  it('uses absolute authored N/E/H points once, without adding source RTC a second time', async () => {
    const source = reference(0, 0, 0);
    const target = reference(990, 2000, 20);
    const parsed = document();
    const updates = await buildLandXmlRenderedLineUpdates(parsed, source, target, undefined);
    applyLandXmlRenderedLineUpdates(updates);
    const line = parsed.surfaces[0].breaklines[0];
    assert.deepStrictEqual(line.renderedPoints, [[12, 4, -3]]);
    assert.deepStrictEqual(line.points, [[2003, 1002, 24]], 'authored points remain immutable');
  });

  it('normalizes LandXML projected feet around proj4 before rebuilding the overlay (#5048)', async () => {
    const parsed = document();
    parsed.units = {
      linearUnit: 'US survey foot', elevationUnit: 'US survey foot',
      linearScaleToMeters: 1200 / 3937, elevationScaleToMeters: 1200 / 3937,
    };
    parsed.surfaces[0].breaklines[0].points = [[0, 200_000, 0]];
    // EPSG:2236 (US survey foot) false-origin → EPSG:32632 in metres.
    const source = reference(0, 0, 0, 'EPSG:2236');
    const target = reference(-9_240_280.602725117, 10_330_575.179250661, 0, 'EPSG:32632');
    const updates = await buildLandXmlRenderedLineUpdates(parsed, source, target, undefined);
    applyLandXmlRenderedLineUpdates(updates);
    assert.deepStrictEqual(parsed.surfaces[0].breaklines[0].renderedPoints, [[0, 0, 0]]);
  });
});
