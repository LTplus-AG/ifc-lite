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
import { extractGeoreferencingOnDemand, IfcParser, type MapConversion } from '@ifc-lite/parser';
import { resolveSpatialPlacement } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render';
import { CrsAssumedBadge } from '@/components/viewer/properties/crs-assumed-badge';
import { crsAssumedFromName, declaredEpsg, mapUnitAssumedMetres, spatialReferenceFromIfc } from './ifc-spatial-reference';

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

/** IFC4 in metres with the given IfcProjectedCRS.MapUnit reference (`#31` metre, `#32` millimetre, `#22` not a unit). */
async function parsedReference(mapUnitRef: string) {
  const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0YvCT2_$X3_xJG3rzD8L_8',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#32= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#50= IFCPROJECTEDCRS('EPSG:2056',$,'CH1903+','LN02',$,$,${mapUnitRef});
#51= IFCMAPCONVERSION(#20,#50,2600000.,1200000.,500.,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;
  const bytes = new TextEncoder().encode(step);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const info = extractGeoreferencingOnDemand(store);
  assert.ok(info?.mapConversion && info.projectedCRS, 'the fixture is georeferenced');
  return spatialReferenceFromIfc({ mapConversion: info.mapConversion, projectedCRS: info.projectedCRS, lengthUnitScale: 1 });
}

test('a map unit that reads as metres is reported as assumed, because an unreadable MapUnit reads the same', async () => {
  // MapUnit pointing at a record that is not a unit: the parser falls back to METRE at scale 1.
  assert.equal(mapUnitAssumedMetres(await parsedReference('#22')), true);
  // A declared metre is indistinguishable from that fallback, so it is reported too.
  assert.equal(mapUnitAssumedMetres(await parsedReference('#31')), true);
  // A resolved millimetre unit, and no MapUnit at all (the project length unit applies), are not.
  assert.equal(mapUnitAssumedMetres(await parsedReference('#32')), false);
  assert.equal(mapUnitAssumedMetres(await parsedReference('$')), false);
});
