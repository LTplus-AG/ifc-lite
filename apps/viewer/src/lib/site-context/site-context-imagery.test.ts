/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two-level aerial drape: the chunks around the model take a 10 cm
 * texture over their own box, the rest the coarse one over the whole site,
 * and a chunk's texture coordinates follow the same ground point into
 * whichever texture it takes, so the image lines up across the chunk edge.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meshPlanBox, planFineDrape, remapUvs, runoffHazardLayer, settleImages, swissimageLayer, wmsMapRequest, withRequestTimeout } from './site-context-imagery';

// A 600 m site split into 4 × 4 chunks of 150 m, as the core does at 300 m radius.
const SITE = [2_680_528, 1_251_142, 2_681_128, 1_251_742] as const;
function chunkUvs(row: number, col: number): Float32Array {
  // Corner UVs of chunk (row, col): u east, v south over the site, top-left origin.
  const u0 = col / 4, u1 = (col + 1) / 4, v0 = row / 4, v1 = (row + 1) / 4;
  return new Float32Array([u0, v0, u1, v0, u0, v1, u1, v1]);
}
const chunks = [0, 1, 2, 3].flatMap((row) => [0, 1, 2, 3].map((col) => chunkUvs(row, col)));

test('a chunk plan box is read back from its UVs', () => {
  assert.deepEqual(meshPlanBox(chunkUvs(0, 0), SITE), [2_680_528, 1_251_592, 2_680_678, 1_251_742]);
  assert.deepEqual(meshPlanBox(chunkUvs(3, 3), SITE), [2_680_978, 1_251_142, 2_681_128, 1_251_292]);
});

test('the fine drape takes the chunks around the model, and the request stays within the texture limit at 10 cm', () => {
  const fine = planFineDrape(chunks.map((uvs) => meshPlanBox(uvs, SITE)), SITE, 100);
  assert.ok(fine);
  // The centre lies on the corner shared by the four middle chunks.
  assert.deepEqual([...fine.indices].sort((a, b) => a - b), [5, 6, 9, 10]);
  assert.deepEqual(fine.box, [2_680_678, 1_251_292, 2_680_978, 1_251_592]);
  const request = wmsMapRequest(swissimageLayer(), fine.box, 0.1)!;
  assert.equal(request.groundSampleDistance, 0.1);
  assert.deepEqual([request.width, request.height], [3000, 3000]);
  assert.match(request.url, /BBOX=2680678%2C1251292%2C2680978%2C1251592/);
  const coarse = wmsMapRequest(swissimageLayer(), SITE)!;
  assert.equal(coarse.groundSampleDistance, 0.25);
  assert.match(coarse.url, /FORMAT=image%2Fjpeg/);
  assert.doesNotMatch(coarse.url, /TRANSPARENT/);
});

test('the overland flow map is asked for as a transparent PNG over the same box at the same pixel size as the imagery', () => {
  const imagery = wmsMapRequest(swissimageLayer(), SITE)!;
  const hazard = wmsMapRequest(runoffHazardLayer(), SITE)!;
  assert.equal(new URL(hazard.url).hostname, 'wms.geo.admin.ch');
  assert.equal(new URL(hazard.url).searchParams.get('LAYERS'), 'ch.bafu.gefaehrdungskarte-oberflaechenabfluss');
  assert.equal(new URL(hazard.url).searchParams.get('FORMAT'), 'image/png');
  assert.equal(new URL(hazard.url).searchParams.get('TRANSPARENT'), 'TRUE');
  assert.equal(hazard.mime, 'image/png');
  assert.deepEqual([hazard.width, hazard.height, hazard.groundSampleDistance], [imagery.width, imagery.height, imagery.groundSampleDistance]);
  assert.equal(new URL(hazard.url).searchParams.get('BBOX'), new URL(imagery.url).searchParams.get('BBOX'));
  assert.equal(runoffHazardLayer().attribution.text, '© FOEN');
});

test('remapped UVs put the same ground point at the same place in the fine texture', () => {
  const fine = planFineDrape(chunks.map((uvs) => meshPlanBox(uvs, SITE)), SITE, 100)!;
  const remapped = remapUvs(chunkUvs(1, 1), SITE, fine.box);
  // Chunk (1, 1) is the north-west quarter of the fine box.
  assert.deepEqual(Array.from(remapped), [0, 0, 0.5, 0, 0, 0.5, 0.5, 0.5]);
  // The shared edge between chunk (1, 1) (fine) and chunk (1, 0) (coarse) is the same ground line in both.
  const edgeInSite = chunkUvs(1, 1)[0];
  const edgeE = SITE[0] + edgeInSite * (SITE[2] - SITE[0]);
  assert.equal(edgeE, fine.box[0]);
});

test('a failed imagery level closes the image that did arrive, and every request is bounded in time (#10481 review)', async () => {
  const closed: string[] = [];
  const image = (name: string) => ({ name, close: () => { closed.push(name); } });
  await assert.rejects(settleImages([Promise.resolve(image('fine')), Promise.reject(new Error('SWISSIMAGE answered 503'))]), /503/);
  assert.deepEqual(closed, ['fine']);
  assert.deepEqual((await settleImages([Promise.resolve(image('a')), Promise.resolve(image('b'))])).map((i) => i.name), ['a', 'b']);
  const bounded = withRequestTimeout(undefined, 20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(bounded.aborted, true, 'a stalled request is given up');
  const user = new AbortController();
  const combined = withRequestTimeout(user.signal, 60_000);
  user.abort();
  assert.equal(combined.aborted, true, 'the user cancel still aborts it');
});
