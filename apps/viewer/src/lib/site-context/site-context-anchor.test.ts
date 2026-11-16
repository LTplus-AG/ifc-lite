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
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { siteContextAnchorRefusal } from '@/hooks/ingest/siteContextLoad';
import { spatialReferenceFromIfc } from '@/lib/geo/ifc-spatial-reference';
import { resolveSiteContextAnchor, siteContextPlacementReference } from './site-context-anchor';

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

afterEach(() => useViewerStore.setState({ models: new Map(), activeModelId: null }));

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
