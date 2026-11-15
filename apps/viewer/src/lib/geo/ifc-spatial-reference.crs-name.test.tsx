/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Well-known CRS names ("CH1903+ / LV95") resolve to their EPSG code, marked
 * as assumed from the name, and that changes what federation can place:
 * before, such a model had no horizontal CRS and every placement against it
 * was refused as `missing-horizontal-crs`.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { MapConversion } from '@ifc-lite/parser';
import { resolveSpatialPlacement } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render';
import { CrsAssumedBadge } from '@/components/viewer/properties/crs-assumed-badge';
import { crsAssumedFromName, declaredEpsg, spatialReferenceFromIfc } from './ifc-spatial-reference';

afterEach(cleanup);

const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 2_600_000, northings: 1_200_000, orthogonalHeight: 500 };
const reference = (name: string, verticalDatum?: string) => spatialReferenceFromIfc({
  mapConversion: conversion, projectedCRS: { id: 3, name, mapUnitScale: 1, ...(verticalDatum ? { verticalDatum } : {}) }, lengthUnitScale: 1,
});

test('a well-known Swiss CRS name resolves to its EPSG code, marked as assumed from the name', () => {
  for (const [name, id] of [['CH1903+ / LV95', 'EPSG:2056'], ['LV95', 'EPSG:2056'], ['CH1903 / LV03', 'EPSG:21781']] as const) {
    const resolved = reference(name);
    assert.equal(resolved.horizontal?.id, id, name);
    assert.equal(resolved.confidence, 'assumed', name);
    assert.equal(resolved.horizontal?.provenance?.source, 'IfcProjectedCRS.Name (well-known name)');
    assert.equal(crsAssumedFromName(name), id);
  }
});

test('a literal EPSG code stays declared, and unknown or datum-only names resolve to nothing', () => {
  assert.deepEqual(declaredEpsg('EPSG:2056'), { id: 'EPSG:2056', fromName: false });
  assert.equal(reference('EPSG:2056').confidence, 'declared');
  assert.equal(crsAssumedFromName('EPSG:2056'), undefined);
  // A geographic datum label names no projection; as an IfcProjectedCRS it would put metres in degrees.
  for (const name of ['WGS 84', 'ETRS89', 'My office grid']) {
    assert.equal(reference(name).horizontal, undefined, name);
    assert.equal(reference(name).confidence, 'unknown', name);
  }
});

test('federation now places a model named "LV95" against one stating EPSG:2056 (it refused before)', () => {
  const named = reference('LV95', 'LN02');
  const coded = reference('EPSG:2056', 'EPSG:5728');
  const placement = resolveSpatialPlacement(named, coded);
  assert.equal(placement.ok, true);
  // A model whose name resolves to nothing is still refused, as before.
  assert.deepEqual(resolveSpatialPlacement(reference('My office grid', 'LN02'), coded), { ok: false, refusal: 'missing-horizontal-crs' });
});

test('the Georeference panel says when the CRS was assumed from its name', () => {
  const host = render(<CrsAssumedBadge crsName="CH1903+ / LV95" />);
  const badge = host.querySelector('[data-testid="crs-assumed-badge"]');
  assert.ok(badge, 'badge shown for a well-known name');
  assert.match(badge.textContent ?? '', /EPSG:2056/);
  assert.match(badge.getAttribute('aria-label') ?? '', /assumed from its name/);
  cleanup();
  const literal = render(<CrsAssumedBadge crsName="EPSG:2056" />);
  assert.equal(literal.querySelector('[data-testid="crs-assumed-badge"]'), null);
});
