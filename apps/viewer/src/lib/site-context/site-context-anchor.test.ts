/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10481 review: with several models loaded, the Site context section must
 * judge heights on the same reference the load places the context against
 * (the federation's reference model), not on the selected model alone.
 * Otherwise the panel states one vertical datum assumption and the load
 * applies another.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { CoordinateInfo, ModelSpatialReference } from '@ifc-lite/geometry';
import { configureCrsLoaders } from '@ifc-lite/geo';
import type { MapConversion } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { siteContextAnchorRefusal } from '@/hooks/ingest/siteContextLoad';
import { siteContextVerticalPolicy } from '@/hooks/ingest/ifcGeorefAssumptions';
import { spatialReferenceFromIfc } from '@/lib/geo/ifc-spatial-reference';
import { anchorStillCurrent, runForCurrentSiteContextAnchor, resolveSiteContextAnchor, siteContextPlacementReference } from './site-context-anchor';

const FRAME: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 10, z: 5 } },
  shiftedBounds: { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 10, z: 5 } },
  hasLargeCoordinates: false,
};
const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 2_600_000, northings: 1_200_000, orthogonalHeight: 500 };

/** An EPSG:2056 model, optionally stating a vertical datum, loaded at `loadedAt`. */
function swissModel(id: string, loadedAt: number, verticalDatum?: string): FederatedModel {
  const spatialReference = spatialReferenceFromIfc({
    mapConversion: conversion,
    projectedCRS: { id: 3, name: 'EPSG:2056', mapUnitScale: 1, ...(verticalDatum ? { verticalDatum } : {}) },
    lengthUnitScale: 1,
    coordinateInfo: FRAME,
  });
  return { ...fixtureModel(id), ifcDataStore: undefined, loadedAt, spatialReference, geometryResult: { meshes: [], coordinateInfo: FRAME } } as unknown as FederatedModel;
}

function seed(...models: FederatedModel[]): void {
  useViewerStore.setState({ models: new Map(models.map((m) => [m.id, m])), activeModelId: models[models.length - 1].id, anchorModelIdOverride: null });
}

afterEach(() => useViewerStore.setState({ models: new Map(), activeModelId: null, georefMutations: new Map(), anchorModelIdOverride: null }));

test('the selected model states no datum, the reference model states LHN95: the panel refuses, as the load does', async () => {
  seed(swissModel('reference', 1, 'LHN95'), swissModel('selected', 2));
  const anchor = await resolveSiteContextAnchor('selected');
  assert.deepEqual(anchor, { ok: false, reason: 'height-datum', detail: 'EPSG:5729' });
  assert.match(siteContextAnchorRefusal(siteContextPlacementReference()) ?? '', /EPSG:5729/);
});

test('the selected model states no datum, the reference model states LN02: nothing is assumed, and the panel does not say so', async () => {
  seed(swissModel('reference', 1, 'LN02'), swissModel('selected', 2));
  const anchor = await resolveSiteContextAnchor('selected');
  assert.equal(anchor.ok, true);
  assert.equal(anchor.ok && anchor.heightAssumed, false);
  assert.equal(siteContextAnchorRefusal(siteContextPlacementReference()), null);
});

test('a single model without a datum is its own reference: the LN02 assumption is stated', async () => {
  seed(swissModel('only', 1));
  const anchor = await resolveSiteContextAnchor('only');
  assert.equal(anchor.ok && anchor.heightAssumed, true);
});

test('a source with native axes and units (north/east/up, US survey feet) is centred through the canonical renderer frame (#10481 review)', async () => {
  const offCentre: CoordinateInfo = {
    ...FRAME,
    originalBounds: { min: { x: 100, y: 0, z: -40 }, max: { x: 120, y: 10, z: -20 } },
    shiftedBounds: { min: { x: 100, y: 0, z: -40 }, max: { x: 120, y: 10, z: -20 } },
  };
  const base = spatialReferenceFromIfc({
    mapConversion: conversion, projectedCRS: { id: 3, name: 'EPSG:2056', mapUnitScale: 1, verticalDatum: 'LN02' }, lengthUnitScale: 1, coordinateInfo: offCentre,
  });
  const scan = { ...base, source: { axes: ['north', 'east', 'up'] as const, horizontalUnitToMetres: 1200 / 3937, verticalUnitToMetres: 1200 / 3937 } };
  const model = { ...fixtureModel('scan'), ifcDataStore: undefined, loadedAt: 1, spatialReference: scan, geometryResult: { meshes: [], coordinateInfo: offCentre } } as unknown as FederatedModel;
  seed(model);
  const anchor = await resolveSiteContextAnchor('scan');
  assert.equal(anchor.ok, true);
  // The renderer's bounds are east/up/south metres: the centre is 110 m east and 30 m north of the conversion origin.
  assert.ok(anchor.ok && Math.abs(anchor.centre.x - (2_600_000 + 110)) < 0.01, `easting ${anchor.ok && anchor.centre.x}`);
  assert.ok(anchor.ok && Math.abs(anchor.centre.y - (1_200_000 + 30)) < 0.01, `northing ${anchor.ok && anchor.centre.y}`);
});

test('a non-IFC model with no vertical datum is not assumed to be LN02: the policy refuses and the panel says why (#10481 review)', async () => {
  const contextRef = { ...swissModel('ctx', 1).spatialReference!, sourceMetadata: { format: 'site-context' } } as ModelSpatialReference;
  const ifcNoDatum = swissModel('ifc', 1).spatialReference!;
  const scanNoDatum = { ...ifcNoDatum, sourceMetadata: { format: 'las' } } as ModelSpatialReference;
  // The decided rule, for IFC only: no datum is assumed LN02 (with a warning).
  assert.equal(siteContextVerticalPolicy(contextRef, ifcNoDatum), 'assume-compatible');
  assert.equal(siteContextVerticalPolicy(ifcNoDatum, contextRef), 'assume-compatible');
  // Any other format: nothing is assumed.
  assert.equal(siteContextVerticalPolicy(contextRef, scanNoDatum), 'refuse');
  assert.equal(siteContextVerticalPolicy(scanNoDatum, contextRef), 'refuse');
  const scan = { ...swissModel('scan', 1), spatialReference: scanNoDatum } as unknown as FederatedModel;
  seed(scan);
  assert.deepEqual(await resolveSiteContextAnchor('scan'), { ok: false, reason: 'height-unknown' });
});

test('a load is dispatched only while the model still resolves to the centre the click captured (#10481 review)', async () => {
  seed(swissModel('m', 1, 'LN02'));
  const captured = await resolveSiteContextAnchor('m');
  assert.ok(captured.ok);
  assert.equal(await anchorStillCurrent('m', captured), true);
  // The georeference is edited between the click and the dispatch: the model now sits 500 m east.
  const moved = spatialReferenceFromIfc({
    mapConversion: { ...conversion, eastings: conversion.eastings + 500 },
    projectedCRS: { id: 3, name: 'EPSG:2056', mapUnitScale: 1, verticalDatum: 'LN02' }, lengthUnitScale: 1, coordinateInfo: FRAME,
  });
  useViewerStore.setState((s) => ({ models: new Map([['m', { ...s.models.get('m')!, spatialReference: moved } as FederatedModel]]) }));
  assert.equal(await anchorStillCurrent('m', captured), false);
});


test('an edit while the lazy loader is pending prevents dispatch after it becomes ready (#10481 review)', async () => {
  seed(swissModel('m', 1, 'LN02'));
  const captured = await resolveSiteContextAnchor('m');
  assert.ok(captured.ok);
  let ready!: (run: () => Promise<void>) => void;
  const imported = new Promise<() => Promise<void>>((resolve) => { ready = resolve; });
  let dispatched = 0;
  const pending = runForCurrentSiteContextAnchor('m', captured, imported);
  // Let a prematurely parallel anchor check finish before the module arrives.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const moved = spatialReferenceFromIfc({
    mapConversion: { ...conversion, eastings: conversion.eastings + 500 },
    projectedCRS: { id: 3, name: 'EPSG:2056', mapUnitScale: 1, verticalDatum: 'LN02' }, lengthUnitScale: 1, coordinateInfo: FRAME,
  });
  useViewerStore.setState((s) => ({ models: new Map([['m', { ...s.models.get('m')!, spatialReference: moved } as FederatedModel]]) }));
  ready(async () => { dispatched++; });
  await pending;
  assert.equal(dispatched, 0);

  seed(swissModel('m', 1, 'LN02'));
  await runForCurrentSiteContextAnchor('m', captured, Promise.resolve(async () => { dispatched++; }));
  assert.equal(dispatched, 1, 'an unchanged anchor dispatches once when the loader is ready');
});


function rectangle(): FederatedModel {
  const model = swissModel('m', 1, 'LN02');
  model.geometryResult = { ...model.geometryResult!, meshes: [{ expressId: 1, ifcType: 'IfcWall', color: [0.5, 0.5, 0.5, 1],
    positions: new Float32Array([-4, 0, -1, 4, 0, -1, 4, 0, 1, -4, 0, 1]), normals: new Float32Array(12), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }] };
  return model;
}

test('rotating a rectangular subject at an unchanged centre refuses the captured footprint (#10481)', async () => {
  const model = rectangle(); seed(model);
  const captured = await resolveSiteContextAnchor('m'); assert.ok(captured.ok && captured.subject?.footprint);
  const rotated = spatialReferenceFromIfc({ mapConversion: { ...conversion, xAxisAbscissa: 0, xAxisOrdinate: 1 },
    projectedCRS: { id: 3, name: 'EPSG:2056', mapUnitScale: 1, verticalDatum: 'LN02' }, lengthUnitScale: 1, coordinateInfo: FRAME });
  seed({ ...model, spatialReference: rotated });
  const fresh = await resolveSiteContextAnchor('m'); assert.ok(fresh.ok);
  assert.deepEqual(fresh.centre, captured.centre);
  assert.notDeepEqual(fresh.subject, captured.subject);
  assert.equal(await anchorStillCurrent('m', captured), false);
  let dispatched = false;
  await runForCurrentSiteContextAnchor('m', captured, Promise.resolve(async () => { dispatched = true; }));
  assert.equal(dispatched, false);
});

test('changes during the footprint projection await refuse the entire result (#10481)', async () => {
  const model = rectangle(); seed(model);
  const pending = resolveSiteContextAnchor('m');
  // The centre continuation runs first, then waits for the four footprint projections.
  queueMicrotask(() => seed({ ...model, spatialReference: { ...model.spatialReference!, confidence: 'assumed' } }));
  assert.deepEqual(await pending, { ok: false, reason: 'stale' });
});

for (const change of ['selected', 'reference-mutation'] as const) {
  test(`a deferred CRS lookup cannot publish an anchor after a ${change} edit (#10481)`, async () => {
    let release!: (definition: string) => void;
    let requested!: () => void;
    const started = new Promise<void>((resolve) => { requested = resolve; });
    const definition = new Promise<string>((resolve) => { release = resolve; });
    const previous = configureCrsLoaders({ epsgDefinition: async () => { requested(); return definition; } });
    try {
      const model = rectangle();
      model.spatialReference = { ...model.spatialReference!, horizontal: { ...model.spatialReference!.horizontal!, id: change === 'selected' ? 'EPSG:999997' : 'EPSG:999998' } };
      seed(swissModel('reference', 0, 'LN02'), model);
      const pending = resolveSiteContextAnchor('m');
      await started;
      if (change === 'selected') seed({ ...model, spatialReference: { ...model.spatialReference, confidence: 'assumed' } });
      else useViewerStore.setState({ georefMutations: new Map([['reference', { projectedCRS: { verticalDatum: 'LHN95' } }]]) });
      release('+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346 +units=m +no_defs');
      assert.deepEqual(await pending, { ok: false, reason: 'stale' });
    } finally { configureCrsLoaders(previous); }
  });
}
