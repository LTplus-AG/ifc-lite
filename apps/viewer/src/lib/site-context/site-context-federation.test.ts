/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Site context placed against real-shaped Swiss anchors through the one
 * federation alignment path. The expected viewer position of a context vertex
 * is derived here by hand from the anchor's IfcMapConversion (no library
 * inverse), so a wrong sign, axis or unit anywhere in the chain shows up as
 * metres, not as a tolerance question.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import proj4 from 'proj4';
import { writeArrayBuffer } from 'geotiff';
import { configureCrsLoaders } from '@ifc-lite/geo';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { resolveSpatialPlacement, type CoordinateInfo } from '@ifc-lite/geometry';
import type { SiteContextDocument, SiteContextLayer } from '@ifc-lite/site-context';
import { alignGeometryToReference, type ModelSpatialPlacement } from '@/hooks/ingest/federationAlign';
import { ifcSharedVerticalDatumApplied, ifcUnknownVerticalPolicy } from '@/hooks/ingest/ifcGeorefAssumptions';
import { siteContextAnchorRefusal } from '@/hooks/ingest/siteContextLoad';
import { spatialReferenceFromIfc } from '@/lib/geo/ifc-spatial-reference';
import { siteContextViewerModel } from './site-context-model';

/** A context vertex: feature origin (absolute LV95 / LN02) plus a float32-exact local offset. */
const FEATURE_ORIGIN: [number, number, number] = [2_680_860.5, 1_251_430.25, 528];
const VERTEX: [number, number, number] = [10.25, -4.5, 2.125];
const TARGET = [FEATURE_ORIGIN[0] + VERTEX[0], FEATURE_ORIGIN[1] + VERTEX[1], FEATURE_ORIGIN[2] + VERTEX[2]] as const;

function contextDocument(): SiteContextDocument {
  const layer: SiteContextLayer = {
    kind: 'terrain',
    features: [{
      id: 'terrain:chunk:r0c0', ifcType: 'IfcGeographicElement', name: 'Terrain r0c0', origin: FEATURE_ORIGIN,
      mesh: {
        positions: new Float32Array([...VERTEX, 20, 0, 0, 0, 20, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
      },
      attributes: { PredefinedType: 'TERRAIN' }, provenance: {},
    }],
    attribution: [], issues: [], complete: true,
  };
  return { crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', origin: [2_680_850, 1_251_440, 527], layers: [layer] };
}

const ZERO_FRAME: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: -50, y: -10, z: -50 }, max: { x: 50, y: 30, z: 50 } },
  shiftedBounds: { min: { x: -50, y: -10, z: -50 }, max: { x: 50, y: 30, z: 50 } },
  hasLargeCoordinates: false,
};

function anchor(projectedCRS: ProjectedCRS, mapConversion: MapConversion, lengthUnitScale: number): ModelSpatialPlacement {
  return { spatialReference: spatialReferenceFromIfc({ mapConversion, projectedCRS, lengthUnitScale, coordinateInfo: ZERO_FRAME }), coordinateInfo: ZERO_FRAME };
}

/** Map → anchor viewer (east, up, south), by hand: local x along (a, b), local y along (−b, a). */
function expectedViewer(e: number, n: number, h: number, e0: number, n0: number, h0: number, angle: number): [number, number, number] {
  const a = Math.cos(angle), b = Math.sin(angle);
  const de = e - e0, dn = n - n0;
  return [a * de + b * dn, h - h0, -(-b * de + a * dn)];
}

async function placedVertex(reference: ModelSpatialPlacement): Promise<[number, number, number]> {
  const doc = contextDocument();
  const payload = siteContextViewerModel(doc, doc.layers[0], new ArrayBuffer(0), 0);
  const geometry = payload.geometryResult;
  const source = { spatialReference: payload.spatialReference, coordinateInfo: geometry.coordinateInfo };
  const policy = ifcUnknownVerticalPolicy(source.spatialReference, reference.spatialReference, false);
  const status = await alignGeometryToReference(geometry, source, reference, { unknownVertical: policy });
  assert.ok(status === 'same-crs' || status === 'reprojected', `placement status ${status}`);
  const mesh = geometry.meshes[0];
  const origin = mesh.origin ?? [0, 0, 0];
  return [origin[0] + mesh.positions[0], origin[1] + mesh.positions[1], origin[2] + mesh.positions[2]];
}

function assertWithin(actual: readonly number[], expected: readonly number[], tolerance: number): void {
  const distance = Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2]);
  assert.ok(distance < tolerance, `off by ${distance.toFixed(4)} m: got ${actual.join(', ')}, expected ${expected.join(', ')}`);
}

test('a context vertex lands within 1 cm against a rotated millimetre EPSG:2056 anchor named "CH1903+ / LV95"', async () => {
  const angle = (30 * Math.PI) / 180;
  const reference = anchor(
    { id: 3, name: 'CH1903+ / LV95', mapUnitScale: 1 },
    // Spec-strict for a millimetre project with metre map units: Scale 0.001.
    { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 2_680_854, northings: 1_251_440, orthogonalHeight: 528.5,
      xAxisAbscissa: Math.cos(angle), xAxisOrdinate: Math.sin(angle), scale: 0.001 },
    0.001,
  );
  assert.equal(reference.spatialReference.horizontal?.id, 'EPSG:2056');
  assert.equal(reference.spatialReference.confidence, 'assumed');
  const placed = await placedVertex(reference);
  assertWithin(placed, expectedViewer(TARGET[0], TARGET[1], TARGET[2], 2_680_854, 1_251_440, 528.5, angle), 0.01);
});

/**
 * LV03 federation is exact only with the CHENYX06 grid; without it the viewer
 * refuses (`approximation-not-authorized`), which is right. Offline, the test
 * supplies a synthetic grid whose shift is CH1903+'s own Helmert shift at the
 * site, so CH1903 + grid ≡ CH1903+ there and the exact expected value is the
 * false-origin offset (2 000 000, 1 000 000). The real grid differs from that
 * offset by the FINELTRA residuals (up to about 1.6 m); this pins the
 * cross-CRS plumbing, not swisstopo's transformation.
 */
function siteHelmertGrid(e: number, n: number): ArrayBuffer {
  const lv95 = '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs';
  const bessel = proj4(lv95, '+proj=longlat +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +no_defs', [e, n]);
  const wgs84 = proj4(lv95, 'WGS84', [e, n]);
  const [dLat, dLon] = [(wgs84[1] - bessel[1]) * 3600, (wgs84[0] - bessel[0]) * 3600];
  // Two bands per pixel, latitude then longitude offsets in arc-seconds, over 8–10° E, 46–48° N.
  return writeArrayBuffer(new Float32Array([dLat, dLon, dLat, dLon, dLat, dLon, dLat, dLon]), {
    width: 2, height: 2, SamplesPerPixel: [2], ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 8, 48, 0], GeographicTypeGeoKey: 4326,
  }) as ArrayBuffer;
}

test('a context vertex lands within 1 cm against an LV03 (EPSG:21781) anchor, reprojected', async () => {
  const angle = (-12 * Math.PI) / 180;
  const previous = configureCrsLoaders({ gridFile: async () => siteHelmertGrid(TARGET[0], TARGET[1]) });
  try {
    const reference = anchor(
      { id: 3, name: 'EPSG:21781', mapUnitScale: 1, verticalDatum: 'LN02' },
      { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 680_854, northings: 251_440, orthogonalHeight: 528.5,
        xAxisAbscissa: Math.cos(angle), xAxisOrdinate: Math.sin(angle) },
      1,
    );
    const placed = await placedVertex(reference);
    assertWithin(placed, expectedViewer(TARGET[0] - 2_000_000, TARGET[1] - 1_000_000, TARGET[2], 680_854, 251_440, 528.5, angle), 0.01);
  } finally {
    configureCrsLoaders(previous);
  }
});

const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 2_600_000, northings: 1_200_000, orthogonalHeight: 540 };
const contextReference = () => {
  const doc = contextDocument();
  return siteContextViewerModel(doc, doc.layers[0], new ArrayBuffer(0), 0).spatialReference;
};

test('an anchor stating no vertical datum is placed as LN02 and the assumption is recorded', () => {
  const ifc = anchor({ id: 3, name: 'EPSG:2056', mapUnitScale: 1 }, conversion, 1).spatialReference;
  const context = contextReference();
  assert.equal(siteContextAnchorRefusal(ifc), null);
  assert.equal(ifcUnknownVerticalPolicy(context, ifc, false), 'assume-compatible');
  // Symmetric: an IFC loaded after the context, with the context as anchor.
  assert.equal(ifcUnknownVerticalPolicy(ifc, context, false), 'assume-compatible');
  assert.equal(ifcSharedVerticalDatumApplied(context, ifc, 'same-crs', false), true);
  assert.equal(resolveSpatialPlacement(context, ifc, { unknownVertical: 'assume-compatible' }).ok, true);
});

test('an anchor declaring LHN95 is refused, not mixed', () => {
  for (const verticalDatum of ['LHN95', 'EPSG:5729', 'Landeshöhennetz 1995']) {
    const ifc = anchor({ id: 3, name: 'EPSG:2056', mapUnitScale: 1, verticalDatum }, conversion, 1).spatialReference;
    assert.equal(ifc.vertical?.id, 'EPSG:5729', verticalDatum);
    assert.match(siteContextAnchorRefusal(ifc) ?? '', /EPSG:5729/);
    const placement = resolveSpatialPlacement(contextReference(), ifc, { unknownVertical: ifcUnknownVerticalPolicy(contextReference(), ifc, true) });
    assert.deepEqual(placement, { ok: false, refusal: 'vertical-crs-mismatch' });
  }
});

test('an unresolvable vertical datum name is refused rather than assumed', () => {
  const ifc = anchor({ id: 3, name: 'EPSG:2056', mapUnitScale: 1, verticalDatum: 'Local site datum' }, conversion, 1).spatialReference;
  assert.equal(ifc.vertical, undefined);
  assert.match(siteContextAnchorRefusal(ifc) ?? '', /Local site datum/);
  assert.equal(ifcUnknownVerticalPolicy(contextReference(), ifc, true), 'refuse');
});

test('an anchor declaring LN02 by name places without any assumption', () => {
  const ifc = anchor({ id: 3, name: 'EPSG:2056', mapUnitScale: 1, verticalDatum: 'LN02' }, conversion, 1).spatialReference;
  assert.equal(ifc.vertical?.id, 'EPSG:5728');
  assert.equal(siteContextAnchorRefusal(ifc), null);
  assert.equal(ifcSharedVerticalDatumApplied(contextReference(), ifc, 'same-crs', false), undefined);
  assert.equal(resolveSpatialPlacement(contextReference(), ifc).ok, true);
});
