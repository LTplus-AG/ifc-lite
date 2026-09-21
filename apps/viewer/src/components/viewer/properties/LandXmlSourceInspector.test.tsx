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
    extensions: [], warnings: [], alignments: [], profiles: [], crossSections: [], crossSectionSurfaces: [], roadways: [], capabilityDiagnostics: [], preservedOnlyExtensions: [],
    plan: {
      version: '1.2', areaUnit: 'squareMeter', areaScaleToSquareMeters: 1,
      cogoPoints: [], monuments: [{ sourceId: 'monument', pointScopeId: null, ordinal: 1, name: 'corner', code: null, description: null, pntRef: 'control', point: null, properties: {} }],
      planFeatures: [{ sourceId: 'feature', ordinal: 1, name: 'road', code: null, description: null, properties: {}, locations: [], geometry: [{ sourceId: 'feature-line', ordinal: 1, kind: 'line', pointScopeId: null, start: { kind: 'coordinates', point: { northing: 1, easting: 2, elevation: null }, pntRef: null }, end: { kind: 'coordinates', point: { northing: 3, easting: 4, elevation: null }, pntRef: null }, center: null, pi: null, intermediatePoints: [], rotation: null, radius: null, declaredLength: null, properties: {} }] }],
      parcels: [{ sourceId: 'parcel', ordinal: 1, name: 'lot', code: null, description: null, title: 'DEED-123', declaredArea: null, declaredPerimeter: null, declaredAreaUnit: null, properties: {}, loops: [[{ sourceId: 'parcel-curve', ordinal: 1, kind: 'curve', pointScopeId: null, start: { kind: 'coordinates', point: { northing: 0, easting: 1, elevation: null }, pntRef: null }, end: { kind: 'coordinates', point: { northing: 0, easting: -1, elevation: null }, pntRef: null }, center: { kind: 'coordinates', point: { northing: 0, easting: 0, elevation: null }, pntRef: null }, pi: null, intermediatePoints: [], rotation: 'ccw', radius: 1, declaredLength: null, properties: {} }]], loopOffsets: [0], preservationReason: null }], warnings: [],
      sourceBatches: [{ sourceIds: ['feature-line', 'parcel-curve'] }],
      parcelProbes: [{ sourceId: 'parcel', state: { kind: 'analytic' }, perimeterInDeclaredLinearUnits: 5.14, areaInDeclaredSquareUnits: 1.57, declaredArea: null, declaredPerimeter: null, perimeterInMeters: 5.14, areaInSquareMeters: 1.57 }],
      resolvedMonuments: [{ sourceId: 'monument', point: { northing: 1, easting: 2, elevation: 3 } }],
      resolvedGeometry: [{ sourceId: 'feature-line', start: { northing: 1, easting: 2, elevation: null }, end: { northing: 3, easting: 4, elevation: null }, center: null, pi: null }, { sourceId: 'parcel-curve', start: { northing: 0, easting: 1, elevation: null }, end: { northing: 0, easting: -1, elevation: null }, center: { northing: 0, easting: 0, elevation: null }, pi: null }],
    },
    rendering: { meshProvenance: [], surfaceCounts: [{ surfaceSourceId: 'surface', sourcePoints: pointCount, sourceFaces: 1, hiddenFaces: 0, renderedFaces: 1, droppedDegenerateFaces: 2, droppedPrecisionFaces: 3, droppedReframeFaces: 4 }] },
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

  it('inspects profile links as bounded review fields rather than serialized source JSON', () => {
    const profileDocument = {
      ...document(),
      profiles: [{ sourceId: 'profile', parentAlignmentSourceId: 'alignment', ordinal: 1, name: 'design', kind: 'design' as const, pvis: [], verticalCurves: [], gradeLines: [] }],
    };
    const selected: string[] = [];
    const ui = render(<LandXmlSourceInspector
      models={new Map([['terrain', { landXmlDocument: profileDocument }]])}
      selected={{ modelId: 'terrain', sourceId: 'profile' }}
      onSelect={(ref) => selected.push(`${ref.modelId}:${ref.sourceId}`)}
    />);
    assert.match(ui.textContent ?? '', /Parent alignment/);
    assert.equal(ui.querySelector('pre'), null);
    const parent = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Parent alignment: alignment');
    assert.ok(parent);
    click(parent);
    assert.deepEqual(selected, ['terrain:alignment']);
    cleanup();
  });

  it('pages engineering profile children and opens a late PVI by source ID (#5045)', () => {
    const profileDocument = document();
    profileDocument.profiles = [{
      sourceId: 'profile', parentAlignmentSourceId: 'alignment', ordinal: 1, name: 'design', kind: 'design',
      pvis: Array.from({ length: 101 }, (_, index) => ({ sourceId: `pvi-${index + 1}`, station: index + 1, elevation: index / 10 })),
      verticalCurves: [{ sourceId: 'curve', parentProfileSourceId: 'profile', kind: 'unsymmetrical_parabolic', station: 20, elevation: 2, length: null, lengthIn: 10, lengthOut: 20, radius: null }],
      gradeLines: [{ sourceId: 'grade-line', parentProfileSourceId: 'profile', ordinal: 1, points: [{ sourceId: 'grade-point', station: 1, elevation: 2 }] }],
    }];
    const selected: string[] = [];
    const ui = render(<LandXmlSourceInspector models={new Map([['terrain', { landXmlDocument: profileDocument }]])}
      selected={{ modelId: 'terrain', sourceId: 'profile' }} onSelect={(ref) => selected.push(`${ref.modelId}:${ref.sourceId}`)} />);
    assert.match(ui.textContent ?? '', /PVI: sta 99/);
    assert.doesNotMatch(ui.textContent ?? '', /PVI: sta 100/);
    const next = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Next');
    assert.ok(next);
    click(next);
    const latePvi = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'PVI: sta 101');
    assert.ok(latePvi);
    click(latePvi);
    assert.deepEqual(selected, ['terrain:pvi-101']);
    cleanup();
  });

  it('shows authored curve and cross-section point engineering values', () => {
    const profileDocument = document();
    profileDocument.profiles = [{
      sourceId: 'profile', parentAlignmentSourceId: 'alignment', ordinal: 1, name: 'design', kind: 'design', pvis: [],
      verticalCurves: [{ sourceId: 'curve', parentProfileSourceId: 'profile', kind: 'unsymmetrical_parabolic', station: 20, elevation: 2, length: null, lengthIn: 10, lengthOut: 20, radius: null }], gradeLines: [],
    }];
    profileDocument.crossSectionSurfaces = [{
      sourceId: 'section-surface', parentCrossSectionSourceId: 'section', kind: 'design', name: 'pavement', segments: [],
      points: [{ sourceId: 'section-point', dataFormat: 'offset_elevation', offset: -4, elevation: 12, slope: null, distance: null, pntRef: 'survey-7', alignmentRef: 'Route', alignRefStation: 12, alignmentSourceId: 'alignment', planFeatureRef: 'feature', planFeatureRefStation: 13, parcelRef: 'parcel', parcelRefStation: 14 }],
    }];
    const models = new Map([['terrain', { landXmlDocument: profileDocument }]]);
    const curve = render(<LandXmlSourceInspector models={models} selected={{ modelId: 'terrain', sourceId: 'curve' }} onSelect={() => {}} />);
    assert.match(curve.textContent ?? '', /Incoming length.*10/);
    assert.match(curve.textContent ?? '', /Outgoing length.*20/);
    cleanup();
    const point = render(<LandXmlSourceInspector models={models} selected={{ modelId: 'terrain', sourceId: 'section-point' }} onSelect={() => {}} />);
    assert.match(point.textContent ?? '', /Signed offset.*-4/);
    assert.match(point.textContent ?? '', /Point reference.*survey-7/);
    assert.match(point.textContent ?? '', /Plan feature reference.*feature/);
    cleanup();
  });

  it('falls back to the source ID for an unnamed cross-section surface', () => {
    const profileDocument = document();
    profileDocument.crossSectionSurfaces = [{
      sourceId: 'section-surface', parentCrossSectionSourceId: 'section', kind: 'design', name: '', segments: [], points: [],
    }];
    const ui = render(<LandXmlSourceInspector
      models={new Map([['terrain', { landXmlDocument: profileDocument }]])}
      selected={{ modelId: 'terrain', sourceId: 'section-surface' }}
      onSelect={() => {}}
    />);
    assert.match(ui.textContent ?? '', /section-surface/);
    cleanup();
  });

  it('mounts plan children, parcel probe fields, curve endpoints and resolved monuments (#5046)', () => {
    const models = new Map([['plan', { landXmlDocument: document() }]]);
    const parcel = render(<LandXmlSourceInspector models={models} selected={{ modelId: 'plan', sourceId: 'parcel' }} onSelect={() => {}} />);
    assert.match(parcel.textContent ?? '', /DEED-123/);
    assert.match(parcel.textContent ?? '', /Status: analytic/);
    assert.match(parcel.textContent ?? '', /Probe: perimeter 5.14, computed area 1.57 squareMeter/);
    assert.ok([...parcel.querySelectorAll('button')].some((button) => button.textContent === 'Geometry parcel-curve'));
    cleanup();

    const mixedUnits = document();
    const mixedParcel = mixedUnits.plan?.parcels[0];
    if (!mixedParcel) throw new Error('parcel fixture is required');
    mixedParcel.declaredAreaUnit = 'squareFoot';
    const mixed = render(<LandXmlSourceInspector models={new Map([['plan', { landXmlDocument: mixedUnits }]])} selected={{ modelId: 'plan', sourceId: 'parcel' }} onSelect={() => {}} />);
    assert.match(mixed.textContent ?? '', /computed area 1.57 squareFoot/);
    cleanup();

    const curve = render(<LandXmlSourceInspector models={models} selected={{ modelId: 'plan', sourceId: 'parcel-curve' }} onSelect={() => {}} />);
    assert.match(curve.textContent ?? '', /Endpoints: 0, 1 → 0, -1/);
    assert.match(curve.textContent ?? '', /Curve: ccw, radius 1, center 0, 0, PI none/);
    cleanup();

    const monument = render(<LandXmlSourceInspector models={models} selected={{ modelId: 'plan', sourceId: 'monument' }} onSelect={() => {}} />);
    assert.match(monument.textContent ?? '', /Resolved monument coordinate: 1, 2, 3/);
    cleanup();
  });
});
