/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { render, click, cleanup } from '@/test/render.js';
import { LandXmlSourceInspector } from './LandXmlSourceInspector.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics';

function document(pointCount = 1): LandXmlTinDocument {
  return {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: true, preservedOnlySurfaces: 1, unknownExtensions: 2 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1 },
    surfaces: [{
      sourceId: 'surface', ordinal: 1, sourcePath: 'LandXML/Surfaces/Surface[1]', properties: { name: 'Existing ground', desc: 'surveyed' }, definitionProperties: { surfType: 'TIN', source: 'field' }, name: 'Existing ground', kind: 'tin', renderState: 'rendered',
      points: Array.from({ length: pointCount }, (_, index) => ({ sourceId: `point-${index + 1}`, id: `P${index + 1}`, northing: 1, easting: 2, elevation: 3 })),
      sourceDataPoints: [{ sourceId: 'source-point', ordinal: 1, sourcePath: 'LandXML/Surfaces/Surface[1]/SourceData/PntList3D', coordinateDimension: 3, coordinates: [1, 2, 3] }],
      faces: [['P1', 'P1', 'P1']], faceSourceIds: ['face'], faceVisibility: [true], hiddenFaceCount: 0,
      boundaries: [{ sourceId: 'boundary', ordinal: 1, name: 'outer', kind: null, sourcePath: 'boundary-path', properties: {}, coordinateDimension: 3, points: [[1, 2, 3]], pointSourceIds: [] }],
      breaklines: [{ sourceId: 'breakline', ordinal: 1, name: 'ridge', kind: null, sourcePath: 'breakline-path', properties: {}, coordinateDimension: 3, points: [[1, 2, 3]], pointSourceIds: [] }],
      contours: [{ sourceId: 'contour', ordinal: 1, name: '100 m', kind: null, sourcePath: 'contour-path', properties: { elev: '100' }, coordinateDimension: 2, points: [[1, 2]], pointSourceIds: [] }],
    }],
    extensions: [], warnings: [], alignments: [], profiles: [], crossSections: [], crossSectionSurfaces: [], roadways: [], capabilityDiagnostics: [], preservedOnlyExtensions: [], rendering: { meshProvenance: [], surfaceCounts: [{ surfaceSourceId: 'surface', sourcePoints: pointCount, sourceFaces: 1, hiddenFaces: 0, renderedFaces: 1, droppedDegenerateFaces: 2, droppedPrecisionFaces: 3, droppedReframeFaces: 4 }] },
  };
}

describe('LandXmlSourceInspector (#5042)', () => {
  it('inspects and navigates retained surfaces, faces, points and overlays', () => {
    const selected: string[] = [];
    const ui = render(<LandXmlSourceInspector
      models={new Map([['terrain', { landXmlDocument: document() }]])}
      selected={{ modelId: 'terrain', sourceId: 'surface' }}
      onSelect={(ref) => selected.push(`${ref.modelId}:${ref.sourceId}`)}
    />);
    assert.match(ui.textContent ?? '', /Existing ground/);
    assert.match(ui.textContent ?? '', /triangle index/);
    assert.match(ui.textContent ?? '', /Render state: rendered/);
    assert.match(ui.textContent ?? '', /"preservedOnlySurfaces":1/);
    assert.match(ui.textContent ?? '', /1 source points, 1 source faces, 1 rendered, 2 degenerate, 3 precision, 4 frame-rejected/);
    assert.match(ui.textContent ?? '', /Surface Properties/);
    assert.match(ui.textContent ?? '', /Definition Properties/);
    assert.match(ui.textContent ?? '', /surveyed/);
    assert.match(ui.textContent ?? '', /TIN/);
    for (const label of ['Point: P1', 'Source point 1', 'Face 1', 'Boundary: outer', 'Breakline: ridge', 'Contour: 100 m']) {
      assert.ok([...ui.querySelectorAll('button')].some((button) => button.textContent === label), `${label} is navigable`);
    }
    const face = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Face 1');
    assert.ok(face);
    click(face);
    assert.deepEqual(selected, ['terrain:face']);
    cleanup();
  });

  it('bounds source navigation to one page for a large retained point list', () => {
    const ui = render(<LandXmlSourceInspector
      models={new Map([['terrain', { landXmlDocument: document(250) }]])}
      selected={{ modelId: 'terrain', sourceId: 'surface' }}
      onSelect={() => {}}
    />);
    assert.equal(ui.querySelectorAll('button').length, 102, 'one hundred source rows plus previous/next controls are mounted');
    const next = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Next');
    assert.ok(next);
    click(next);
    assert.ok([...ui.querySelectorAll('button')].some((button) => button.textContent === 'Point: P100'));
    cleanup();
  });
});
