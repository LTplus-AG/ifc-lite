/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { render, click, cleanup } from '@/test/render.js';
import { LandXmlSourceInspector } from './LandXmlSourceInspector.js';
import { LandXmlModelSourceNavigation } from './LandXmlModelSourceNavigation.js';
import { parseAlignmentProbeInputs, superelevationEventPage } from './LandXmlAlignmentSourceInspector.js';
import type { LandXmlTinDocument } from '@/hooks/ingest/landXmlSemantics';

function document(pointCount = 1): LandXmlTinDocument {
  return {
    format: 'landxml', schema: 'LandXML-1.2', version: '1.2',
    capabilities: { renderableTin: true, preservedOnlySurfaces: 1, unknownExtensions: 2 },
    units: { linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false },
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
      schema: 'LandXML-1.2', version: '1.2', capabilityDiagnostics: [],
      areaUnit: 'squareMeter', areaScaleToSquareMeters: 1,
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

describe('LandXML alignment probe input', () => {
  it('distinguishes a missing displayed station from an explicit zero (#5044)', () => {
    assert.equal(parseAlignmentProbeInputs('station', '0', '', '0'), null);
    assert.deepEqual(parseAlignmentProbeInputs('station', '0', '0', '0'), { value: 0, offsetRight: 0 });
  });
});

function pipeDocument(): LandXmlTinDocument {
  const result = document();
  const metre = { value: 1, unit: 'meter', meters: 1 };
  const units = { linearUnit: 'meter', elevationUnit: 'meter', diameterUnit: 'meter', widthUnit: 'meter', heightUnit: 'meter', flowUnit: 'cubicMeterPerSecond', linearScaleToMeters: 1, elevationScaleToMeters: 1, diameterScaleToMeters: 1, widthScaleToMeters: 1, heightScaleToMeters: 1 };
  const pipeId = 'pipe';
  result.pipeNetworks = {
    schema: 'LandXML-1.2', version: '1.2', capabilityDiagnostics: [], rootUnits: units,
    collections: [{ sourceId: 'collection', sourcePath: 'LandXML/PipeNetworks[1]', properties: { name: 'collection' } }], features: [], refusals: [],
    networks: [{ sourceId: 'network', sourcePath: 'LandXML/PipeNetworks[1]/PipeNetwork[1]', name: 'storm', pipeNetworkType: 'storm', properties: { owner: 'city' }, structureUnits: units, pipeUnits: units, features: [],
      structures: [{ sourceId: 'structure', sourcePath: 'Struct[1]', name: 'A', properties: {}, units, center: { northing: 0, easting: 0, northingMeters: 0, eastingMeters: 0, elevation: metre }, part: { kind: 'circular', properties: {}, diameter: metre, material: 'concrete' }, rimElevation: metre, sumpElevation: metre, inverts: [{ sourceId: 'invert', sourcePath: 'Invert[1]', pipeSourceId: pipeId, flowDirection: 'out', elevation: metre, properties: {} }], flow: { sourceId: 'flow', sourcePath: 'StructFlow', unit: 'cubicMeterPerSecond', flowIn: null, lossIn: 1, lossOut: 2, properties: {} } }],
      pipes: [{ sourceId: pipeId, sourcePath: 'Pipe[1]', name: 'P-1', properties: { owner: 'city' }, units, connectivity: { startStructureSourceId: 'structure', endStructureSourceId: 'structure' }, part: { kind: 'circular', properties: { material: 'PVC' }, diameter: metre, thickness: metre, material: 'PVC' }, geometry: { kind: 'straight', point: null }, length: metre, flow: { sourceId: 'pipe-flow', sourcePath: 'PipeFlow', unit: 'cubicMeterPerSecond', flowIn: 4.2, lossIn: null, lossOut: null, properties: {} } }],
    }],
  };
  return result;
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

  it('navigates an explicitly refused transition and displays its refusal (#5044)', () => {
    const source = document();
    source.alignments = [{ sourceId: 'alignment', ordinal: 1, name: 'Main', length: 10, staStart: 0,
      profileSourceIds: [], crossSectionSourceIds: [],
      segments: [{ sourceId: 'transition', ordinal: 1, primitive: { kind: 'unsupported_spiral', start: { kind: 'coordinates', point: { northing: 0, easting: 0, elevation: null } }, pi: { kind: 'coordinates', point: { northing: 5, easting: 5, elevation: null } }, end: { kind: 'coordinates', point: { northing: 10, easting: 0, elevation: null } }, spiType: 'bloss', declaredLength: 10 } }],
      cantStations: [], superelevations: [], unsupportedTransitions: [{ sourceId: 'transition:refusal', sourceSourceId: 'transition', spiType: 'bloss', reason: 'retained but unsupported' }] }];
    const selected: string[] = [];
    const ui = render(<LandXmlSourceInspector models={new Map([['alignment-model', { landXmlDocument: source }]])} selected={{ modelId: 'alignment-model', sourceId: 'alignment' }} onSelect={(ref) => selected.push(ref.sourceId)} />);
    assert.match(ui.textContent ?? '', /Refused bloss/);
    const refusal = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Refused bloss'));
    assert.ok(refusal);
    click(refusal);
    assert.deepEqual(selected, ['transition:refusal']);
    cleanup();
  });

  it('paginates alignment spans and the refusal without mounting every record (#5044)', () => {
    const source = document();
    const primitive = { kind: 'line' as const, start: { kind: 'coordinates' as const, point: { northing: 0, easting: 0, elevation: null } }, end: { kind: 'coordinates' as const, point: { northing: 10, easting: 0, elevation: null } }, declaredLength: 10 };
    source.alignments = [{ sourceId: 'alignment', ordinal: 1, name: 'Main', length: 990, staStart: 0,
      profileSourceIds: [], crossSectionSourceIds: [],
      segments: Array.from({ length: 99 }, (_, index) => ({ sourceId: `segment-${index + 1}`, ordinal: index + 1, primitive })),
      cantStations: [], superelevations: [], unsupportedTransitions: [{ sourceId: 'segment-99:refusal', sourceSourceId: 'segment-99', spiType: 'bloss', reason: 'retained but unsupported' }] }];
    const props = { modelId: 'alignment-model', document: source, selected: null, onSelect: () => {} };
    const ui = render(<LandXmlModelSourceNavigation {...props} />);
    const alignmentRows = [...ui.querySelectorAll('button')].filter((button) => /^(Alignment:|Segment |Refused )/.test(button.textContent ?? ''));
    assert.equal(alignmentRows.length, 100, 'only one bounded page of alignment rows is mounted');
    const next = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Next');
    assert.ok(next);
    click(next);
    assert.ok([...ui.querySelectorAll('button')].some((button) => button.textContent?.includes('Refused bloss')), 'the final refusal occupies its own navigable page');
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

  it('shows typed pipe engineering fields and collection/network metadata (#5047)', () => {
    const models = new Map([['pipes', { landXmlDocument: pipeDocument() }]]);
    const pipe = render(<LandXmlSourceInspector models={models} selected={{ modelId: 'pipes', sourceId: 'pipe' }} onSelect={() => {}} />);
    assert.match(pipe.textContent ?? '', /cross-section: circular/);
    assert.match(pipe.textContent ?? '', /thickness: 1 meter \(1 m\)/);
    assert.match(pipe.textContent ?? '', /flow in: 4.2/);
    assert.match(pipe.textContent ?? '', /linear unit: meter/);
    cleanup();
    const network = render(<LandXmlSourceInspector models={models} selected={{ modelId: 'pipes', sourceId: 'network' }} onSelect={() => {}} />);
    assert.match(network.textContent ?? '', /network type: storm/);
    assert.match(network.textContent ?? '', /structures: 1/);
    cleanup();
    const collection = render(<LandXmlSourceInspector models={models} selected={{ modelId: 'pipes', sourceId: 'collection' }} onSelect={() => {}} />);
    assert.match(collection.textContent ?? '', /root linear unit: meter/);
    assert.match(collection.textContent ?? '', /collection/);
    cleanup();
  });

  it('pages hostile superelevation event sets without materializing a UI-sized result (#5044)', () => {
    const events = Array.from({ length: 10_000 }, (_, index) => ({ sourceId: `event-${index}`, kind: 'full_superelev', value: `${index}` }));
    const first = superelevationEventPage([{ sourceId: 'super', staStart: null, staEnd: null, events }], 0);
    const last = superelevationEventPage([{ sourceId: 'super', staStart: null, staEnd: null, events }], 9_900);
    assert.equal(first.total, 10_000);
    assert.equal(first.items.length, 100);
    assert.equal(last.items.length, 100);
    assert.equal(last.items[99].sourceId, 'event-9999');
  });

  it('clamps a stale superelevation page when a new probe has fewer applicable events (#5044)', () => {
    const page = superelevationEventPage([{ sourceId: 'later', staStart: 5, staEnd: 5, events: [
      { sourceId: 'only-event', kind: 'full_superelev', value: '0.04' },
    ] }], 100);
    assert.equal(page.total, 1);
    assert.deepEqual(page.items.map((event) => event.sourceId), ['only-event']);
  });
});
