/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcAPI } from '@ifc-lite/wasm';
import { parseLandXmlViewerModelAsync, parseLandXmlViewerModelFromBlobAsync } from './landXmlViewerModel.js';
import { connectedFaceComponents, parseLandXmlGeometry, preflightLandXmlGeometry } from './landXmlIngest.js';
import { buildLandXmlPipeComponents } from './landXmlPipeGeometry.js';
import { findLandXmlSourceRecord, type LandXmlPipeNetworkDocument } from './landXmlSemantics.js';
import { isLandXmlContent } from './landXmlSniff.js';
import {
  parseLandXmlSourceInCurrentRealm, parseLandXmlTinInCurrentRealm, readLandXmlTinDocument,
} from './landXmlWasm.js';
import { inspectLandXmlAlignmentAtDistance } from './landXmlAlignmentWasm.js';
import { initLandXmlWasm } from './landXmlWasmInit.js';

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
          <F i="true">20 40 30</F>
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

function sharedBytes(buffer: ArrayBuffer): SharedArrayBuffer {
  const shared = new SharedArrayBuffer(buffer.byteLength);
  new Uint8Array(shared).set(new Uint8Array(buffer));
  return shared;
}

const parseDocument = (text: string) => parseLandXmlTinInCurrentRealm(bytes(text));
const parseViewer = (buffer: ArrayBuffer | SharedArrayBuffer) => parseLandXmlViewerModelAsync(buffer);

function assertSectionNormals(mesh: { normals: Float32Array }): void {
  const normals = Array.from(mesh.normals);
  assert.ok(normals.every(Number.isFinite));
  for (let index = 0; index < normals.length; index += 3) {
    assert.ok(Math.abs(Math.hypot(normals[index], normals[index + 1], normals[index + 2]) - 1) < 1e-5);
  }
  assert.ok(normals.some((value, index) => index % 3 === 0 && Math.abs(value) > 0.5));
  assert.ok(normals.some((value, index) => index % 3 === 1 && Math.abs(value) > 0.05));
}

function worldCoordinate(value: number, origin: readonly number[] | undefined, axis: number): number {
  const offset = origin?.[axis];
  if (offset === undefined) throw new Error(`mesh origin is missing axis ${axis}`);
  return value + offset;
}

it('reports pipe mesh truncation even after ordinary warning capacity is exhausted (#5047)', () => {
  const units = {
    linearUnit: 'meter', elevationUnit: 'meter', diameterUnit: 'meter', widthUnit: 'meter', heightUnit: 'meter', flowUnit: null,
    linearScaleToMeters: 1, elevationScaleToMeters: 1, diameterScaleToMeters: 1, widthScaleToMeters: 1, heightScaleToMeters: 1,
  };
  const elevation = { value: 0, unit: 'meter', meters: 0 };
  const structure = (sourceId: string, easting: number) => ({
    sourceId, sourcePath: sourceId, name: sourceId, properties: {}, units,
    center: { northing: 0, easting, northingMeters: 0, eastingMeters: easting, elevation },
    part: { kind: 'circular' as const, properties: {}, diameter: { value: 1, unit: 'meter', meters: 1 }, material: null },
    rimElevation: null, sumpElevation: null, inverts: [], flow: null,
  });
  const pipe = (index: number) => ({
    sourceId: `pipe-${index}`, sourcePath: `/pipe-${index}`, name: `pipe-${index}`, properties: {}, units,
    connectivity: { startStructureSourceId: 'start', endStructureSourceId: 'end' },
    part: { kind: 'circular' as const, properties: {}, diameter: { value: 1, unit: 'meter', meters: 1 }, material: null },
    geometry: { kind: 'straight' as const, point: null }, length: null, flow: null,
  });
  const validPipes = Array.from({ length: 10_001 }, (_, index) => pipe(index));
  const refusedPipes = Array.from({ length: 1_000 }, (_, index) => pipe(20_000 + index));
  const document: LandXmlPipeNetworkDocument = {
    version: '1.2', rootUnits: units, collections: [], features: [],
    networks: [{
      sourceId: 'network', sourcePath: '/network', name: 'network', pipeNetworkType: '', properties: {},
      structureUnits: units, pipeUnits: units, structures: [structure('start', 0), structure('end', 1)],
      pipes: [...refusedPipes, ...validPipes], features: [],
    }],
    refusals: refusedPipes.map((candidate) => ({ sourceId: candidate.sourceId, sourcePath: candidate.sourcePath, code: 'invalid_semantic', message: 'refused' })),
  };

  const result = buildLandXmlPipeComponents(document, 1);
  assert.equal(result.components.length, 10_000);
  assert.equal(result.warnings.length, 1_000);
  assert.match(result.warnings.at(-1) ?? '', /Stopped LandXML pipe rendering after 10000 meshes/);
});

describe('LandXML content dispatch (#5041)', () => {
  it('recognizes default and prefixed roots without claiming generic XML', () => {
    assert.equal(isLandXmlContent(new Uint8Array(bytes(LANDXML))), true);
    const prefixed = LANDXML
      .replace('<LandXML xmlns=', '<lx:LandXML xmlns:lx=')
      .replace('</LandXML>', '</lx:LandXML>');
    assert.equal(isLandXmlContent(new Uint8Array(bytes(prefixed))), true);
    assert.equal(isLandXmlContent(new TextEncoder().encode(
      '<?xml version="1.0"?><ids xmlns="http://standards.buildingsmart.org/IDS"/>',
    )), false);
    assert.equal(isLandXmlContent(new TextEncoder().encode(
      '<ifcXML xmlns="http://www.buildingsmart-tech.org/ifcXML/IFC4/final"/>',
    )), false);
  });

  it('recognizes UTF-16 LandXML and rejects a spoofed nested element', () => {
    assert.equal(isLandXmlContent(new Uint8Array(utf16LeBytes(LANDXML))), true);
    assert.equal(isLandXmlContent(new Uint8Array(utf16LeBytes(LANDXML)).subarray(2)), true);
    assert.equal(isLandXmlContent(new TextEncoder().encode(
      `<document><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2"/></document>`,
    )), false);
  });

  it('finds the root after a legal prolog longer than the old 4 KiB head slice', () => {
    const longProlog = `<!--${'x'.repeat(8 * 1024)}-->\n${LANDXML}`;
    assert.equal(isLandXmlContent(new TextEncoder().encode(longProlog)), true);
  });

  it('finds the namespace after a quoted greater-than sign in the root tag', () => {
    const quoted = LANDXML.replace('<LandXML ', '<LandXML note="a > b" ');
    assert.equal(isLandXmlContent(new TextEncoder().encode(quoted)), true);
  });
});

describe('LandXML 1.2 TIN ingest (#4937)', () => {
  it('matches direct geometry through the bounded Blob cursor (#5050)', async () => {
    const direct = await parseViewer(bytes(LANDXML));
    const streamed = await parseLandXmlViewerModelFromBlobAsync(new Blob([LANDXML]));
    assert.deepEqual(
      streamed.geometryResult.meshes.map((mesh) => ({
        expressId: mesh.expressId, positions: Array.from(mesh.positions), indices: Array.from(mesh.indices), origin: mesh.origin,
      })),
      direct.geometryResult.meshes.map((mesh) => ({
        expressId: mesh.expressId, positions: Array.from(mesh.positions), indices: Array.from(mesh.indices), origin: mesh.origin,
      })),
    );
    assert.deepEqual(streamed.semanticDocument.plan, direct.semanticDocument.plan);
  });

  it('uses the exact discard-after-measurement frame on the second pass (#5050)', async () => {
    const parsed = await parseDocument(LANDXML.replace(
      '</Faces>', '<F>10 20 30</F></Faces>',
    ));
    const preflight = preflightLandXmlGeometry(parsed);
    const direct = parseLandXmlGeometry(parsed);
    const secondPass = parseLandXmlGeometry(parsed, preflight);
    assert.equal(preflight.componentCount, secondPass.geometryResult.meshes.length);
    assert.deepEqual(secondPass.geometryResult.coordinateInfo, direct.geometryResult.coordinateInfo);
    assert.deepEqual(
      secondPass.geometryResult.meshes.map((mesh) => [mesh.expressId, mesh.origin, Array.from(mesh.indices)]),
      direct.geometryResult.meshes.map((mesh) => [mesh.expressId, mesh.origin, Array.from(mesh.indices)]),
    );
  });

  it('loads persisted pre-triangulation surface records without new optional fields (#5043)', async () => {
    await initLandXmlWasm();
    const api = new IfcAPI();
    try {
      const raw = api.parseLandXmlTinBytes(new TextEncoder().encode(LANDXML)) as unknown as {
        surfaces: Array<Record<string, unknown>>;
      };
      delete raw.surfaces[0].topology_origin;
      delete raw.surfaces[0].canonical_vertices;
      const parsed = readLandXmlTinDocument(raw);
      assert.equal(parsed.surfaces[0].topologyOrigin, undefined);
      assert.equal(parsed.surfaces[0].canonicalVertices, undefined);
    } finally {
      api.free();
    }
  });

  it('parses schema point order while retaining hidden faces and non-TIN surfaces', async () => {
    const parsed = await parseDocument(LANDXML);
    assert.equal(parsed.version, '1.2');
    assert.equal(parsed.surfaces.length, 2);
    assert.equal(parsed.surfaces[0].name, 'Existing Ground');
    assert.equal(parsed.surfaces[0].sourceId, 'landxml:surface:1');
    assert.deepEqual(parsed.surfaces[0].points[0], {
      sourceId: 'landxml:surface:1:point:10', id: '10', northing: 5_000_000, easting: 2_600_000, elevation: 100,
    });
    assert.deepEqual(parsed.surfaces[0].faces, [['10', '20', '30'], ['20', '40', '30']]);
    assert.deepEqual(parsed.surfaces[0].faceVisibility, [true, false]);
    assert.equal(parsed.surfaces[0].hiddenFaceCount, 1);
    assert.equal(parsed.surfaces[1].kind, 'grid');
    assert.equal(parsed.surfaces[1].renderState, 'preserved_only');
    assert.match(parsed.warnings[0], /Unsupported Grid/);
  });

  it('retains canonical terrain contributor source IDs from the real WASM bridge (#5043)', async () => {
    const faceless = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
      <Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="grade"><Definition surfType="TIN"><Pnts>
        <P id="1">0 0 0</P><P id="2">0 0 0</P><P id="3">0 10 0</P><P id="4">10 10 0</P><P id="5">10 0 0</P>
      </Pnts><Boundaries><Boundary bndType="outer"><PntList3D>0 0 0 0 10 0 10 10 0 10 0 0</PntList3D></Boundary></Boundaries></Definition></Surface></Surfaces></LandXML>`;
    const parsed = await parseDocument(faceless);
    const canonical = parsed.surfaces[0].canonicalVertices?.find(
      (vertex) => vertex.northing === 0 && vertex.easting === 0,
    );
    assert.deepEqual(canonical?.contributorSourceIds, [
      'landxml:surface:1:point:1',
      'landxml:surface:1:point:2',
      'landxml:surface:1:boundary:1:point:1',
    ]);
  });

  it('retains COGO and analytic plan records from the canonical WASM document (#5046)', async () => {
    const parsed = await parseDocument(LANDXML.replace(
      '</Surfaces>',
      `</Surfaces><CgPoints><CgPoint name="control">5000000 2600000 100</CgPoint></CgPoints>
      <PlanFeatures><PlanFeature name="right-of-way"><CoordGeom><Line><Start pntRef="control"/><End>5000010 2600010 102</End></Line></CoordGeom></PlanFeature></PlanFeatures>
      <Parcels><Parcel name="lot"><CoordGeom><Line><Start pntRef="control"/><End>5000010 2600010</End></Line></CoordGeom></Parcel></Parcels>`,
    ));
    assert.equal(parsed.plan?.cogoPoints[0].name, 'control');
    assert.equal(parsed.plan?.planFeatures[0].geometry[0].kind, 'line');
    assert.equal(parsed.plan?.parcels[0].name, 'lot');
  });

  it('decodes the complete alignment endpoint and rebuilds its source index (#5044)', async () => {
    const parsed = await parseLandXmlSourceInCurrentRealm(bytes(`<?xml version="1.0"?>
      <LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
        <Units><Metric linearUnit="meter" elevationUnit="meter"/></Units>
        <CgPoints><CgPoint name="control">0 0 0</CgPoint></CgPoints>
        <Alignments><Alignment name="route" length="10" staStart="0"><CoordGeom>
          <Line length="10"><Start>0 0</Start><End>0 10</End></Line>
        </CoordGeom><Cant name="rail" gauge="1.435" rotationPoint="center" equilibriumConstant="11" appliedCantConstant="12">
          <CantStation station="0" appliedCant="20" equilibriumCant="22" curvature="ccw" cantDeficiency="2" cantExcess="3" rateOfChangeOfAppliedCantOverTime="4" rateOfChangeOfAppliedCantOverLength="5" rateOfChangeOfCantDeficiencyOverTime="6" cantGradient="7" speed="8" transitionType="linear" adverse="true"/>
          <SpeedStation station="0" speed="90"/>
        </Cant></Alignment></Alignments>
      </LandXML>`));
    assert.equal(parsed.plan?.cogoPoints[0]?.name, 'control');
    assert.equal(parsed.alignments[0]?.segments.length, 1);
    const cant = parsed.alignments[0]?.cant;
    assert.equal(cant?.name, 'rail');
    assert.equal(cant?.gauge, 1.435);
    assert.equal(cant?.rotationPoint, 'center');
    assert.equal(cant?.equilibriumConstant, 11);
    assert.equal(cant?.appliedCantConstant, 12);
    assert.equal(cant?.stations[0]?.cantGradient, 7);
    assert.equal(cant?.stations[0]?.adverse, true);
    assert.equal(cant?.speedStations[0]?.speed, 90);
    const inspection = await inspectLandXmlAlignmentAtDistance(bytes(`<?xml version="1.0"?>
      <LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Alignments><Alignment name="route" length="10" staStart="0"><CoordGeom><Line length="10"><Start>0 0</Start><End>0 10</End></Line></CoordGeom><Cant name="rail" gauge="1.435"><CantStation station="0" appliedCant="20" curvature="ccw" cantGradient="7" adverse="true"/></Cant></Alignment></Alignments></LandXML>`), parsed.alignments[0].sourceId, 0);
    assert.equal(inspection.previousCantStation?.cantGradient, 7);
    assert.equal(inspection.previousCantStation?.adverse, true);
    const alignment = findLandXmlSourceRecord(parsed, parsed.alignments[0].sourceId);
    assert.equal(alignment?.kind, 'alignment');
    assert.equal(alignment?.kind === 'alignment' ? alignment.alignment.segments.length : 0, 1);
    assert.equal(findLandXmlSourceRecord(parsed, parsed.alignments[0].segments[0].sourceId)?.kind, 'alignment-segment');
  });

  it('keeps a profile-only alignment valid through the complete source endpoint (#5044/#5045)', async () => {
    const parsed = await parseLandXmlSourceInCurrentRealm(bytes(`<?xml version="1.0"?>
      <LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units>
        <Alignments><Alignment name="profile route" length="10" staStart="0"><Profile><ProfAlign name="design"><PVI>0 1</PVI><PVI>10 2</PVI></ProfAlign></Profile></Alignment></Alignments>
      </LandXML>`));
    assert.equal(parsed.alignments[0]?.name, 'profile route');
    assert.equal(parsed.alignments[0]?.segments.length, 0);
    assert.equal(parsed.profiles[0]?.pvis.length, 2);
  });

  it('bounds hostile real-WASM superelevation inspection results (#5044)', async () => {
    const events = Array.from({ length: 10_000 }, (_, index) => `<FullSuperelev>${index}</FullSuperelev>`).join('');
    const xml = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Alignments><Alignment name="route" length="10" staStart="0"><CoordGeom><Line length="10"><Start>0 0</Start><End>0 10</End></Line></CoordGeom><Superelevation staStart="0" staEnd="10">${events}</Superelevation></Alignment></Alignments></LandXML>`;
    const parsed = await parseLandXmlSourceInCurrentRealm(bytes(xml));
    const inspection = await inspectLandXmlAlignmentAtDistance(bytes(xml), parsed.alignments[0].sourceId, 5);
    assert.equal(inspection.superelevationEventCount, 10_000);
    assert.equal(inspection.superelevations[0]?.events.length, 100);
    assert.equal(inspection.superelevationTruncated, true);
  });

  it('keeps source selection stable after geometry is partitioned (#5042)', async () => {
    const parsed = await parseDocument(LANDXML.replace(
      '</Faces>',
      '</Faces><Boundaries><Boundary><PntList3D>1 2 3 4 5 6</PntList3D></Boundary></Boundaries>',
    ));
    const point = findLandXmlSourceRecord(parsed, 'landxml:surface:1:point:10');
    assert.equal(point?.kind, 'point');
    const face = findLandXmlSourceRecord(parsed, 'landxml:surface:1:face:1');
    assert.deepEqual(face?.kind === 'face' ? face.pointIds : null, ['10', '20', '30']);
    const boundary = findLandXmlSourceRecord(parsed, 'landxml:surface:1:boundary:1');
    assert.equal(boundary?.kind, 'boundary');
  });

  it('loads a geometry-free source without fabricating IFC entities (#5042)', async () => {
    const sourceOnly = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
      <Surfaces><Surface name="Survey volume"><Definition surfType="VOLUME"/></Surface></Surfaces>
    </LandXML>`;
    const result = await parseViewer(bytes(sourceOnly));
    assert.equal(result.dataStore.entityCount, 0);
    assert.equal(result.geometryResult.meshes.length, 0);
    assert.equal(result.semanticDocument.surfaces[0].renderState, 'preserved_only');
  });

  it('derives a finite frame for very large finite source overlays (#5042)', async () => {
    const sourceOnly = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
      <Units><Metric linearUnit="meter" elevationUnit="meter"/></Units>
      <Surfaces><Surface name="Extreme"><Definition surfType="VOLUME"/><SourceData>
        <Boundaries><Boundary><PntList3D>1e308 1e308 1e308 1e308 1e308 1e308</PntList3D></Boundary></Boundaries>
      </SourceData></Surface></Surfaces>
    </LandXML>`;
    const result = await parseViewer(bytes(sourceOnly));
    const frame = result.geometryResult.coordinateInfo;
    assert.equal(result.semanticDocument.surfaces[0].boundaries.length, 1);
    assert.equal(frame.originShift.x, 1e308);
    assert.ok(Object.values(frame.originShift).every(Number.isFinite));
    assert.ok(Object.values(frame.shiftedBounds.min).every(Number.isFinite));
    assert.ok(Object.values(frame.shiftedBounds.max).every(Number.isFinite));
  });

  it('preserves an empty or fully hidden TIN without requiring render units (#5042)', async () => {
    const hiddenWithoutUnits = LANDXML
      .replace(/\s*<Units>[\s\S]*?<\/Units>/, '')
      .replace('<F>10 20 30</F>', '<F i="true">10 20 30</F>');
    const result = await parseViewer(bytes(hiddenWithoutUnits));
    assert.equal(result.geometryResult.meshes.length, 0);
    assert.equal(result.semanticDocument.rendering.surfaceCounts[0].hiddenFaces, 2);
    assert.equal(result.semanticDocument.rendering.surfaceCounts[0].renderedFaces, 0);
  });

  it('produces a rebased Y-up render mesh without losing survey coordinates', async () => {
    const result = await parseViewer(bytes(LANDXML));
    assert.equal(result.geometryResult.meshes.length, 1);
    assert.equal(result.geometryResult.totalTriangles, 1);
    assert.equal(result.geometryResult.totalVertices, 3);
    assert.deepEqual(result.surfaceNames, ['Existing Ground']);

    const mesh = result.geometryResult.meshes[0];
    assert.deepEqual(mesh.origin, [0, 0, 0]);
    assert.deepEqual(Array.from(mesh.positions.slice(0, 9)), [
      -5, -1, 5,
      5, -1, 5,
      -5, 1, -5,
    ]);
    assert.deepEqual(Array.from(mesh.indices), [0, 1, 2]);
    assert.ok(mesh.normals[1] > 0, 'terrain normal must face viewer-up');
    assert.equal(result.geometryResult.coordinateInfo.hasLargeCoordinates, true);
    assert.deepEqual(result.geometryResult.coordinateInfo.originShift, {
      x: 2_600_005, y: 101, z: -5_000_005,
    });
    assert.deepEqual(result.geometryResult.coordinateInfo.shiftedBounds, {
      min: { x: -5, y: -1, z: -5 },
      max: { x: 5, y: 1, z: 5 },
    });
    assert.equal(result.geometryResult.coordinateInfo.originalBounds.min.x, 2_600_000);
    assert.equal(result.geometryResult.coordinateInfo.originalBounds.max.z, -5_000_000);
  });

  it('excludes points unused by visible faces from vertex and camera bounds', async () => {
    const withOutlier = LANDXML.replace(
      '</Pnts>',
      '<P id="99">900000000 800000000 700000000</P></Pnts>',
    );
    const result = await parseViewer(bytes(withOutlier));
    assert.equal(result.geometryResult.totalVertices, 3);
    assert.deepEqual(result.geometryResult.meshes[0].origin, [0, 0, 0]);
    assert.equal(result.geometryResult.coordinateInfo.originalBounds.max.x, 2_600_010);
  });

  it('excludes distant points referenced only by a rejected degenerate face', async () => {
    const withDegenerateOutlier = LANDXML
      .replace(
        '</Pnts>',
        `<P id="50">900000000 800000000 700000000</P>
         <P id="51">900000001 800000001 700000001</P>
         <P id="52">900000002 800000002 700000002</P></Pnts>`,
      )
      .replace('</Faces>', '<F>50 51 52</F></Faces>');
    const result = await parseViewer(bytes(withDegenerateOutlier));
    assert.equal(result.geometryResult.totalVertices, 3);
    assert.equal(result.geometryResult.totalTriangles, 1);
    assert.deepEqual(result.geometryResult.meshes[0].origin, [0, 0, 0]);
    assert.ok(result.warnings.some((warning) => /Skipped 1 degenerate face/.test(warning)));
  });

  it('preserves finite world bounds for a valid surface wider than 20 km', async () => {
    const wide = LANDXML.replaceAll('2600010', '2630000');
    const result = await parseViewer(bytes(wide));
    assert.equal(result.geometryResult.coordinateInfo.originalBounds.min.x, 2_600_000);
    assert.equal(result.geometryResult.coordinateInfo.originalBounds.max.x, 2_630_000);
    assert.ok(Number.isFinite(result.geometryResult.coordinateInfo.shiftedBounds.max.x));
  });

  it('keeps disconnected components the shared render frame can place on their own local origins', async () => {
    const withNearbySmallFace = LANDXML
      .replace(
        '</Pnts>',
        `<P id="50">5100000 2700000 100</P>
         <P id="51">5100000 2700001 100</P>
         <P id="52">5100001 2700000 100</P></Pnts>`,
      )
      .replace('</Faces>', '<F>50 51 52</F></Faces>');
    const result = await parseViewer(bytes(withNearbySmallFace));
    assert.equal(result.geometryResult.meshes.length, 2);
    assert.equal(result.geometryResult.totalVertices, 6);
    assert.equal(result.geometryResult.totalTriangles, 2);
    const { originShift } = result.geometryResult.coordinateInfo;
    assert.deepEqual(originShift, { x: 2_600_005, y: 101, z: -5_000_005 }, 'the frame is centred on the dominant component');
    assert.deepEqual(result.geometryResult.meshes[0].origin, [0, 0, 0]);
    assert.deepEqual(result.geometryResult.meshes[1].origin, [
      2_700_000.5 - originShift.x,
      100 - originShift.y,
      -5_100_000.5 - originShift.z,
    ]);
    assert.equal(result.geometryResult.coordinateInfo.originalBounds.max.x, 2_700_001);
    assert.equal(result.warnings.some((warning) => /degenerate face|render frame/.test(warning)), false);
  });

  it('skips a disconnected component the shared render frame cannot place precisely', async () => {
    const withDistantSmallFace = LANDXML
      .replace(
        '</Pnts>',
        `<P id="50">900000000 800000000 700000000</P>
         <P id="51">900000000 800000001 700000000</P>
         <P id="52">900000001 800000000 700000000</P></Pnts>`,
      )
      .replace('</Faces>', '<F>50 51 52</F></Faces>');
    const result = await parseViewer(bytes(withDistantSmallFace));
    assert.equal(result.geometryResult.meshes.length, 1);
    assert.equal(result.geometryResult.totalTriangles, 1);
    assert.deepEqual(result.geometryResult.meshes[0].origin, [0, 0, 0]);
    assert.deepEqual(result.geometryResult.coordinateInfo.originShift, { x: 2_600_005, y: 101, z: -5_000_005 });
    assert.equal(result.geometryResult.coordinateInfo.originalBounds.max.x, 2_600_010, 'skipped components do not stretch the frame bounds');
    assert.ok(result.warnings.some((warning) => /Skipped 1 surface component\(s\) whose full Y-up bounds exceed 1000 km/.test(warning)));
    assert.equal(result.semanticDocument.rendering.surfaceCounts[0].droppedReframeFaces, 1);
  });

  it('removes the survey translation before GPU upload and retains it as frame metadata', async () => {
    const surveyOnly = LANDXML
      .replaceAll('5000000', '900000000')
      .replaceAll('5000010', '900000001')
      .replaceAll('2600000', '800000000')
      .replaceAll('2600010', '800000001');
    const result = await parseViewer(bytes(surveyOnly));
    const mesh = result.geometryResult.meshes[0];
    const info = result.geometryResult.coordinateInfo;

    assert.deepEqual(mesh.origin, [0, 0, 0], 'the uploaded model translation is render-frame local');
    assert.deepEqual(info.originShift, { x: 800_000_000.5, y: 101, z: -900_000_000.5 });
    assert.deepEqual(info.originalBounds, {
      min: { x: 800_000_000, y: 100, z: -900_000_001 },
      max: { x: 800_000_001, y: 102, z: -900_000_000 },
    });
    assert.deepEqual(info.shiftedBounds, {
      min: { x: -0.5, y: -1, z: -0.5 },
      max: { x: 0.5, y: 1, z: 0.5 },
    });
  });

  it('rejects a connected component whose full Y-up bounds exceed one f32 frame', async () => {
    const connectedAcrossSurveyRange = LANDXML
      .replace(
        '</Pnts>',
        `<P id="50">900000000 800000000 700000000</P>
         <P id="51">900000000 800000001 700000000</P>
         <P id="52">900000001 800000000 700000000</P>
         <P id="60">900001000 800001000 700000100</P></Pnts>`,
      )
      .replace('</Faces>', '<F>50 51 52</F><F>30 50 60</F></Faces>');
    await assert.rejects(
      parseViewer(bytes(connectedAcrossSurveyRange)),
      /no surface components whose full Y-up bounds fit within the 1000 km render-frame limit/,
      'a connected component cannot be partially registered after its full extent exceeds one f32 frame',
    );
  });

  it('walks a high-valence face fan without rescanning its shared point adjacency (#4937)', () => {
    const faceCount = 10_000;
    const faces = Array.from({ length: faceCount }, (_, index) => (
      ['center', `outer-${index}`, `outer-${index + 1}`] as [string, string, string]
    ));
    const components = connectedFaceComponents(faces);
    assert.equal(components.length, 1);
    assert.equal(components[0].length, faceCount);
  });

  it('passes raw XML-required UTF-16 input to the Rust parser', async () => {
    const utf16 = LANDXML.replace('encoding="UTF-8"', 'encoding="UTF-16"');
    const result = await parseViewer(utf16LeBytes(utf16));
    assert.equal(result.geometryResult.totalTriangles, 1);
    assert.deepEqual(result.surfaceNames, ['Existing Ground']);
  });

  it('passes SAB-backed UTF-8 and UTF-16 bytes without TextDecoder', async () => {
    const utf8 = await parseViewer(sharedBytes(bytes(LANDXML)));
    const utf16 = await parseViewer(sharedBytes(utf16LeBytes(LANDXML.replace('encoding="UTF-8"', 'encoding="UTF-16"'))));
    assert.equal(utf8.geometryResult.totalTriangles, 1);
    assert.equal(utf16.geometryResult.totalTriangles, 1);
    assert.deepEqual(utf16.surfaceNames, ['Existing Ground']);
  });

  it('applies the declared horizontal and elevation units independently', async () => {
    const imperial = LANDXML
      .replace('<Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter"\n      temperatureUnit="celsius" pressureUnit="milliBars" elevationUnit="meter"/>',
        '<Imperial areaUnit="squareFoot" linearUnit="USSurveyFoot" volumeUnit="cubicFeet" temperatureUnit="fahrenheit" pressureUnit="inchHG" elevationUnit="feet"/>')
      .replaceAll('5000000', '0').replaceAll('2600000', '0').replaceAll('2600010', '10')
      .replaceAll('5000010', '10');
    const result = await parseViewer(bytes(imperial));
    const info = result.geometryResult.coordinateInfo.originalBounds;
    assert.ok(Math.abs(info.max.x - (10 * 1200 / 3937)) < 1e-6);
    assert.ok(Math.abs(info.max.y - (102 * 0.3048)) < 1e-5);
  });

  it('uses the LandXML meter default when elevationUnit is omitted (#5042)', async () => {
    const imperial = LANDXML
      .replace('<Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter"\n      temperatureUnit="celsius" pressureUnit="milliBars" elevationUnit="meter"/>',
        '<Imperial areaUnit="squareFoot" linearUnit="foot" volumeUnit="cubicFeet" temperatureUnit="fahrenheit" pressureUnit="inchHG"/>')
      .replace('<P id="10">5000000 2600000 100</P>', '<P id="10">0 0 3</P>')
      .replace('<P id="20">5000000 2600010 100</P>', '<P id="20">0 3 3</P>')
      .replace('<P id="30">5000010 2600000 102</P>', '<P id="30">3 0 6</P>');
    const result = await parseViewer(bytes(imperial));
    const info = result.geometryResult.coordinateInfo.originalBounds;
    assert.ok(Math.abs(info.max.y - 6) < 1e-12, 'elevation uses the schema-default meter scale');
  });

  it('retains the authored frame of geometry-free 2D contours (#5046)', async () => {
    const contourOnly = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
      <Units><Metric linearUnit="meter" elevationUnit="meter"/></Units>
      <Surfaces><Surface name="contours"><Definition surfType="TIN"/><SourceData><Contours>
        <Contour name="100" elev="100"><PntList2D>5000000 2600000 5000010 2600010</PntList2D></Contour>
      </Contours></SourceData></Surface></Surfaces>
    </LandXML>`;
    const result = await parseViewer(bytes(contourOnly));
    const bounds = result.geometryResult.coordinateInfo.originalBounds;
    assert.deepEqual(bounds.min, { x: 2_600_000, y: 100, z: -5_000_010 });
    assert.deepEqual(bounds.max, { x: 2_600_010, y: 100, z: -5_000_000 });
    assert.equal(result.geometryResult.coordinateInfo.hasLargeCoordinates, true);
  });

  it('preserves the stable Rust error code for unsupported units', async () => {
    const inheritedUnit = LANDXML.replace('linearUnit="meter"', 'linearUnit="constructor"');
    await assert.rejects(
      parseViewer(bytes(inheritedUnit)),
      /LXML009: unsupported LandXML unit/,
    );
  });

  it('preserves the stable Rust error code for an unknown face point', async () => {
    await assert.rejects(
      parseDocument(LANDXML.replace('<F>10 20 30</F>', '<F>10 20 999</F>')),
      /LXML009: face references unknown point/,
    );
  });

  it('resolves positive-integer point ids by XML Schema value, not spelling', async () => {
    const parsed = await parseDocument(LANDXML
      .replace('<P id="10">', '<P id="+0010">')
      .replace('<F>10 20 30</F>', '<F>00010 +20 030</F>'));
    assert.equal(parsed.surfaces[0].points[0].id, '10');
    assert.deepEqual(parsed.surfaces[0].faces, [['10', '20', '30'], ['20', '40', '30']]);
    assert.deepEqual(parsed.surfaces[0].faceVisibility, [true, false]);
  });

  it('ignores extension elements that reuse LandXML local names', async () => {
    const withExtensionSurface = LANDXML.replace(
      '</Surfaces>',
      `<ext:Surface xmlns:ext="urn:vendor-extension" name="Not terrain">
        <ext:Definition surfType="TIN"/>
      </ext:Surface></Surfaces>`,
    );
    const parsed = await parseDocument(withExtensionSurface);
    assert.deepEqual(parsed.surfaces.map((surface) => surface.name), ['Existing Ground', 'Unsupported Grid']);
    assert.equal(parsed.surfaces.some((surface) => surface.name === 'Not terrain'), false);
    assert.equal(parsed.extensions.some((extension) => extension.namespace === 'urn:vendor-extension' && extension.localName === 'Surface'), true);
  });

  it('preserves the stable namespace diagnostic', async () => {
    await assert.rejects(
      parseDocument(LANDXML.replace(
        'http://www.landxml.org/schema/LandXML-1.2',
        'urn:not-landxml',
      )),
      /LXML007: root namespace is not a recognized LandXML namespace/,
    );
  });

  it('rejects a LandXML 1.1 namespace even when the version attribute says 1.2', async () => {
    await assert.rejects(
      parseDocument(LANDXML.replace(
        'http://www.landxml.org/schema/LandXML-1.2',
        'http://www.landxml.org/schema/LandXML-1.1',
      )),
      /LXML008: LandXML 1.1 is recognized but TIN ingestion supports 1.2 only/,
    );
  });

  it('requires the exact LandXML 1.2 namespace', async () => {
    await assert.rejects(
      parseDocument(LANDXML.replace(
        'http://www.landxml.org/schema/LandXML-1.2',
        'urn:vendor:LandXML-1.2',
      )),
      /LXML007: root namespace is not a recognized LandXML namespace/,
    );
    await assert.rejects(
      parseDocument(LANDXML.replace(
        ' xmlns="http://www.landxml.org/schema/LandXML-1.2"',
        '',
      )),
      /LXML007: root namespace is not a recognized LandXML namespace/,
    );
  });

  it('parses without the window-only DOMParser global used by the browser main thread', async () => {
    assert.equal(globalThis.DOMParser, undefined);
    assert.equal((await parseDocument(LANDXML)).surfaces[0].name, 'Existing Ground');
  });

  it('renders validated pipe routes in metres and retains model-qualified provenance (#5047)', async () => {
    const pipes = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Imperial linearUnit="foot" diameterUnit="inch"/></Units><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>0 10 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="straight" refStart="A" refEnd="B"><CircPipe diameter="12"/></Pipe><Pipe name="route" refStart="A" refEnd="B"><CircPipe diameter="12"/><Center>5 5 0</Center></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>`;
    const parsed = await parseDocument(pipes);
    assert.ok(Math.abs((parsed.pipeNetworks?.networks[0].pipes[0].part.diameter?.meters ?? 0) - 0.3048) < Number.EPSILON);
    assert.equal(parsed.pipeNetworks?.networks[0].structures[1].center.eastingMeters, 3.048);
    const viewer = await parseViewer(bytes(pipes));
    assert.equal(viewer.geometryResult.meshes.length, 2, 'straight and declared pass-through routes each render once');
    assert.equal(viewer.semanticDocument.rendering.meshProvenance.every((mesh) => mesh.pipeSourceId !== undefined), true);
  });

  it('renders rectangular pipes with authored width and height rather than a circular fallback (#5047)', async () => {
    const pipes = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter" widthUnit="meter" heightUnit="meter"/></Units><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>10 0 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="box" refStart="A" refEnd="B"><RectPipe width="2" height="10"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>`;
    const viewer = await parseViewer(bytes(pipes));
    const mesh = viewer.geometryResult.meshes[0];
    assert.ok(mesh);
    const world = Array.from(mesh.positions).reduce((bounds, value, index) => {
      const axis = index % 3, coordinate = worldCoordinate(value, mesh.origin, axis);
      bounds.min[axis] = Math.min(bounds.min[axis], coordinate); bounds.max[axis] = Math.max(bounds.max[axis], coordinate);
      return bounds;
    }, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    assert.equal(world.max[0] - world.min[0], 2);
    assert.equal(world.max[1] - world.min[1], 10);
    assertSectionNormals(mesh);
    const ellipse = await parseViewer(bytes(pipes.replace('<RectPipe width="2" height="10"/>', '<ElliPipe span="2" height="10"/>')));
    const ellipseMesh = ellipse.geometryResult.meshes[0];
    assert.ok(ellipseMesh);
    const ellipseWorld = Array.from(ellipseMesh.positions).reduce((bounds, value, index) => {
      const axis = index % 3, coordinate = worldCoordinate(value, ellipseMesh.origin, axis);
      bounds.min[axis] = Math.min(bounds.min[axis], coordinate); bounds.max[axis] = Math.max(bounds.max[axis], coordinate);
      return bounds;
    }, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    assert.ok(Math.abs((ellipseWorld.max[0] - ellipseWorld.min[0]) - 2) < 1e-6);
    assert.ok(Math.abs((ellipseWorld.max[1] - ellipseWorld.min[1]) - 9.510565) < 1e-5, 'the ten-sided ellipse follows its authored height, not a 2 m circle');
    assertSectionNormals(ellipseMesh);
    const egg = await parseViewer(bytes(pipes.replace('<RectPipe width="2" height="10"/>', '<EggPipe span="2" height="10"/>')));
    assert.equal(egg.geometryResult.meshes.length, 0);
    assert.ok(egg.warnings.some((warning) => warning.includes('Egg pipe cross-section is retained but not rendered')));
  });

  it('keeps finite non-zero normals for representable micro-pipes (#5047)', async () => {
    const pipes = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>10 0 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="micro" refStart="A" refEnd="B"><CircPipe diameter="1e-20"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>`;
    const viewer = await parseViewer(bytes(pipes));
    const mesh = viewer.geometryResult.meshes[0];
    assert.ok(mesh);
    assertSectionNormals(mesh);
  });

  it('does not forge pipe feature owners through unexpected wrappers in the real WASM contract (#5047)', async () => {
    const pipes = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><PipeNetworks><Unexpected><Feature><Property label="bad-collection" value="yes"/></Feature></Unexpected><PipeNetwork name="storm" pipeNetType="storm"><Structs><Unexpected><Feature><Property label="bad-structs" value="yes"/></Feature></Unexpected><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>10 0 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"><Unexpected><Feature><Property label="bad-pipe" value="yes"/></Feature></Unexpected></CircPipe><Feature><Property label="direct" value="yes"/></Feature></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>`;
    const parsed = await parseDocument(pipes);
    const allFeatures = [
      ...(parsed.pipeNetworks?.features ?? []),
      ...(parsed.pipeNetworks?.networks.flatMap((network) => network.features) ?? []),
    ];
    assert.deepEqual(allFeatures.map((feature) => feature.properties.direct), ['yes']);
    assert.equal(allFeatures.some((feature) => Object.keys(feature.properties).some((key) => key.startsWith('bad-'))), false);
  });

  it('refuses incomplete pipe routes locally without fabricating a partial segment (#5047)', async () => {
    const pipes = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="B"><Center>10 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="C"><Center>0 10 0</Center><CircStruct diameter="1"/></Struct><Struct name="D"><Center>10 10 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="bad-center" refStart="A" refEnd="B"><CircPipe diameter="1"/><Center>5 0</Center></Pipe><Pipe name="bad-start" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe><Pipe name="good" refStart="C" refEnd="D"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>`;
    const parsed = await parseDocument(pipes);
    assert.equal(parsed.pipeNetworks?.networks[0].pipes.length, 3, 'source semantics remain inspectable');
    const viewer = await parseViewer(bytes(pipes));
    assert.equal(viewer.geometryResult.meshes.length, 2, 'the valid sibling and ordinary complete pipe render');
    assert.ok(viewer.warnings.some((warning) => warning.includes('bad-center') && warning.includes('every endpoint')));

    const missingStart = pipes.replace('<Center>0 0 0</Center>', '<Center>0 0</Center>');
    const missingStartViewer = await parseViewer(bytes(missingStart));
    assert.equal(missingStartViewer.geometryResult.meshes.length, 1, 'a 2D start Center never creates a partial route');
    assert.ok(missingStartViewer.warnings.some((warning) => warning.includes('bad-start')));
  });

  it('uses pipe-specific endpoint inverts when an authored structure Center is two-dimensional (#5047)', async () => {
    const pipes = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0</Center><CircStruct diameter="1"/><Invert refPipe="P" flowDir="out" elev="4"/></Struct><Struct name="B"><Center>10 0</Center><CircStruct diameter="1"/><Invert refPipe="P" flowDir="in" elev="2"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>`;
    const viewer = await parseViewer(bytes(pipes));
    assert.equal(viewer.geometryResult.meshes.length, 1);
    const mesh = viewer.geometryResult.meshes[0];
    assert.ok(mesh);
    const elevations = Array.from(mesh.positions).filter((_, index) => index % 3 === 1).map((value) => worldCoordinate(value, mesh.origin, 1));
    assert.ok(Math.min(...elevations) < 2.1 && Math.max(...elevations) > 3.9, 'the endpoint route follows the per-pipe invert elevations');
  });

  it('refuses only a pipe with conflicting endpoint inverts and exposes its real-WASM diagnostic (#5047)', async () => {
    const pipes = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/><Invert refPipe="bad" flowDir="out" elev="4"/><Invert refPipe="bad" flowDir="out" elev="40"/></Struct><Struct name="B"><Center>10 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="C"><Center>0 10 0</Center><CircStruct diameter="1"/></Struct><Struct name="D"><Center>10 10 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="bad" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe><Pipe name="good" refStart="C" refEnd="D"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>`;
    const parsed = await parseDocument(pipes);
    const badPipe = parsed.pipeNetworks?.networks[0]?.pipes.find((pipe) => pipe.name === 'bad');
    assert.ok(badPipe);
    const refusal = parsed.pipeNetworks?.refusals.find((item) => item.sourceId === badPipe.sourceId);
    assert.ok(refusal);
    assert.equal(refusal.message, 'conflicting authored endpoint Invert elevations');
    assert.ok(refusal.code.length > 0);
    assert.equal(refusal.sourcePath, badPipe.sourcePath);
    const viewer = await parseViewer(bytes(pipes));
    assert.equal(viewer.geometryResult.meshes.length, 1, 'the valid no-invert sibling retains legitimate Center fallback');
    assert.ok(viewer.warnings.some((warning) => warning.includes(`(${badPipe.sourceId})`) && warning.includes(refusal.code) && warning.includes(refusal.sourcePath)));
    assert.ok(viewer.warnings.some((warning) => warning.includes('bad') && warning.includes('source semantic refusal')));
  });

  it('keeps one-metre endpoint conflicts visible at huge elevations while exact duplicates remain valid (#5047)', async () => {
    const base = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 1000000000000000</Center><CircStruct diameter="1"/><Invert refPipe="P" flowDir="out" elev="1000000000000000"/><Invert refPipe="P" flowDir="out" elev="ELEVATION"/></Struct><Struct name="B"><Center>10 0 1000000000000000</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="P" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe><Pipe name="sibling" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>`;
    const conflict = base.replace('ELEVATION', '1000000000000001');
    const parsed = await parseDocument(conflict);
    const pipe = parsed.pipeNetworks?.networks[0]?.pipes.find((candidate) => candidate.name === 'P');
    assert.ok(pipe);
    assert.ok(parsed.pipeNetworks?.refusals.some((refusal) => (
      refusal.sourceId === pipe.sourceId && refusal.message === 'conflicting authored endpoint Invert elevations'
    )));
    const viewer = await parseViewer(bytes(conflict));
    assert.equal(viewer.geometryResult.meshes.length, 1, 'only the unaffected sibling renders');
    assert.ok(viewer.warnings.some((warning) => warning.includes('P') && warning.includes('conflicting authored endpoint Invert elevations')));

    const duplicates = base.replace('ELEVATION', '1000000000000000');
    const duplicateParsed = await parseDocument(duplicates);
    assert.equal(duplicateParsed.pipeNetworks?.refusals.length, 0);
    assert.equal(duplicateParsed.pipeNetworks?.networks[0]?.structures[0]?.inverts.length, 1);
    const duplicateViewer = await parseViewer(bytes(duplicates));
    assert.equal(duplicateViewer.geometryResult.meshes.length, 2);
    assert.equal(duplicateViewer.warnings.length, 0);
  });

  it('does not fall back to a structure Center after an invalid authored endpoint invert (#5047)', async () => {
    const pipes = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><PipeNetworks><PipeNetwork name="storm" pipeNetType="storm"><Structs><Struct name="A"><Center>0 0 0</Center><CircStruct diameter="1"/><Invert refPipe="bad" flowDir="out" elev="bad"/></Struct><Struct name="B"><Center>10 0 0</Center><CircStruct diameter="1"/></Struct><Struct name="C"><Center>0 10 0</Center><CircStruct diameter="1"/></Struct><Struct name="D"><Center>10 10 0</Center><CircStruct diameter="1"/></Struct></Structs><Pipes><Pipe name="bad" refStart="A" refEnd="B"><CircPipe diameter="1"/></Pipe><Pipe name="good" refStart="C" refEnd="D"><CircPipe diameter="1"/></Pipe></Pipes></PipeNetwork></PipeNetworks></LandXML>`;
    const parsed = await parseDocument(pipes);
    const badPipe = parsed.pipeNetworks?.networks[0]?.pipes.find((pipe) => pipe.name === 'bad');
    assert.ok(badPipe);
    assert.ok(parsed.pipeNetworks?.refusals.some((item) => item.sourceId === badPipe.sourceId && item.message === 'an authored endpoint Invert is invalid'));
    const viewer = await parseViewer(bytes(pipes));
    assert.equal(viewer.geometryResult.meshes.length, 1, 'the bad pipe cannot silently route at Center elevation zero');
    assert.ok(viewer.warnings.some((warning) => warning.includes('bad') && warning.includes('an authored endpoint Invert is invalid')));
  });
});
