/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Neighbouring buildings in the viewer: roof and wall drawn in their own
 * colours while the building stays one entity; the model's own building, when
 * the core finds it, starts hidden and the card can show it again; the
 * swissBUILDINGS3D host is reachable and nothing beside it; the 3D Tiles
 * reader shares the IndexedDB cache.
 */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import type { SiteContextFeature, SiteContextLayer } from '@ifc-lite/site-context';
import { cleanup, click, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { SiteContextCard } from '@/components/viewer/properties/SiteContextCard';
import { subjectOf } from '@/hooks/ingest/siteContextLoad';
import { applyInitialHiddenState } from '@/hooks/ingest/initialHiddenState';
import { siteContextViewerModel, siteContextModelName } from './site-context-model';
import { isAllowedSwisstopoUrl } from '@ifc-lite/site-context';
import { buildingsReadBudget } from './site-context-job';
import { createSiteContextResponseCache, tilesCacheView } from './response-cache';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

/** Two box-ish buildings: index ranges roof first, then wall, as the core writes them. */
function buildingsLayer(subjectIndex: number | null): SiteContextLayer {
  const building = (n: number): SiteContextFeature => ({
    id: `building:egid:${100 + n}`, ifcType: 'IfcBuilding', name: `Gebäude ${100 + n}`, origin: [2_680_900 + n * 30, 1_251_500, 528] as [number, number, number],
    mesh: {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 8, 10, 0, 8, 10, 10, 8, 0, 10, 8]),
      normals: new Float32Array(24),
      indices: new Uint32Array([4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5]),
      parts: [{ name: 'roof', firstIndex: 0, indexCount: 6 }, { name: 'wall', firstIndex: 6, indexCount: 12 }],
    },
    attributes: { IfcLite_SiteContextBuilding: { EGID: `${100 + n}`, UUID: `uuid-${n}`, ObjectType: 'Gebaeude Einzelhaus', TotalHeight: 8, RoofMin: 8, RoofMax: 8, TerrainPoint: 528 } },
    provenance: n === subjectIndex ? { subjectMatch: { method: 'footprint', overlap: 0.83, threshold: 0.5 } } : { subjectMatch: null },
    ...(n === subjectIndex ? { subject: true as const } : {}),
  });
  return {
    kind: 'buildings', features: [building(0), building(1)],
    attribution: [{ datasetId: 'swissbuildings3d', text: '© swisstopo (swissBUILDINGS3D)', licence: 'OGD', termsUrl: 'https://example.invalid', restrictions: [], termsVerifiedOn: '2026-11-15' }],
    issues: [{ code: 'buildings-missing-egid', severity: 'info', message: '3 buildings carry no EGID', count: 3 }], complete: true,
  };
}
const DOC = { crs: 'EPSG:2056' as const, verticalCrs: 'EPSG:5728' as const, origin: [2_680_850, 1_251_440, 527] as [number, number, number] };

test('each building is drawn as a roof mesh and a wall mesh of one entity, with the core\'s index ranges', () => {
  const { geometryResult, dataStore } = siteContextViewerModel(DOC, buildingsLayer(null), new ArrayBuffer(0), 0);
  assert.equal(geometryResult.meshes.length, 4, 'two parts for each of two buildings');
  const [roof, wall] = geometryResult.meshes;
  assert.equal(roof.expressId, 1);
  assert.equal(wall.expressId, 1, 'one building, one entity');
  assert.deepEqual(Array.from(roof.indices), [4, 5, 6, 4, 6, 7]);
  assert.equal(wall.indices.length, 12);
  assert.notDeepEqual(roof.color, wall.color, 'roof and wall have their own colours');
  // Neutral massing: both nearly grey (a trace of warmth at most), the roof clearly darker than the wall.
  for (const c of [roof.color, wall.color]) assert.ok(Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) <= 0.02, `desaturated: ${c.join(', ')}`);
  assert.ok(wall.color[0] - roof.color[0] >= 0.15, 'roof clearly darker than the wall');
  assert.ok(wall.color[0] < 0.8, 'wall held below white so sunlit faces keep form');
  assert.equal(roof.positions, wall.positions, 'parts share the building\'s vertices');
  assert.equal(dataStore.getEntitiesByType('IfcBuilding').length, 2);
  assert.equal(dataStore.properties.getPropertyValue(1, 'IfcLite_SiteContextBuilding', 'EGID'), '100');
  assert.equal(siteContextModelName('buildings'), 'Site context · Buildings');
});

test('the building the core marks as the model\'s own is found, and none is when nothing matched', () => {
  assert.deepEqual(subjectOf(buildingsLayer(1)), { expressIds: [2], name: 'Gebäude 101', method: 'footprint', overlap: 0.83 });
  assert.equal(subjectOf(buildingsLayer(null)), null, 'no match: nothing to hide');
});

test('the hidden subject is listed on the card and can be shown and hidden again', () => {
  const model = fixtureModel('buildings', { idOffset: 1000 });
  useViewerStore.setState({ ...fixtureModels(model) });
  const subject = subjectOf(buildingsLayer(1))!;
  act(() => {
    useViewerStore.getState().registerSiteContextModel('buildings', {
      kind: 'buildings', attribution: buildingsLayer(1).attribution, issues: buildingsLayer(1).issues, complete: true, origin: DOC.origin, hiddenSubject: subject,
    });
    applyInitialHiddenState('buildings', subject.expressIds);
  });
  const globalId = useViewerStore.getState().toGlobalId('buildings', 2);
  assert.ok(useViewerStore.getState().hiddenEntities.has(globalId), 'starts hidden');
  const host = render(<SiteContextCard model={model} />);
  const notice = host.querySelector('[data-testid="site-context-subject"]');
  assert.ok(notice);
  assert.match(notice.textContent ?? '', /Gebäude 101/);
  assert.match(notice.textContent ?? '', /83 %/);
  assert.match(host.textContent ?? '', /3 buildings carry no EGID/, 'layer issues on the card');
  assert.match(host.textContent ?? '', /swissBUILDINGS3D/, 'layer attribution on the card');
  click(notice.querySelector('button')!);
  assert.equal(useViewerStore.getState().hiddenEntities.has(globalId), false, 'shown again');
  click(notice.querySelector('button')!);
  assert.ok(useViewerStore.getState().hiddenEntities.has(globalId), 'and hidden again');
});

test('swissBUILDINGS3D\'s host is allowed, look-alikes and other hosts are not', () => {
  assert.ok(isAllowedSwisstopoUrl('https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json'));
  assert.ok(isAllowedSwisstopoUrl('https://data.geo.admin.ch/api/stac/v1/collections'));
  for (const url of ['http://3d.geo.admin.ch/x', 'https://3d.geo.admin.ch.evil.example/x', 'https://cdn.example.com/tileset.json', 'https://3d.geo.admin.ch:8443/x', 'not a url']) {
    assert.equal(isAllowedSwisstopoUrl(url), false, url);
  }
});

test('the 3D Tiles reader reads back through the shared IndexedDB cache, apart from the geodata keys', async () => {
  const cache = createSiteContextResponseCache();
  const tiles = tilesCacheView(cache);
  const url = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json';
  await tiles.set(url, new Uint8Array([7, 8, 9]));
  assert.deepEqual(Array.from((await tiles.get(url))!), [7, 8, 9]);
  assert.equal(await cache.get(url), undefined, 'a geodata lookup of the same URL is a different key');
  assert.equal(cache.hits, 1);
});

test('the 3D Tiles read budget grows with the site area and keeps the preset at 300 m', () => {
  assert.deepEqual(buildingsReadBudget(300), { maxRequests: 64, maxBytes: 32 * 1024 * 1024 });
  assert.deepEqual(buildingsReadBudget(100), { maxRequests: 64, maxBytes: 32 * 1024 * 1024 }, 'never below the preset');
  assert.equal(buildingsReadBudget(500).maxRequests, 178);
  assert.equal(buildingsReadBudget(5000).maxBytes, 128 * 1024 * 1024, 'bytes capped');
});
