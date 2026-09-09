/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import type { AppearancePlan, AppearanceRequest } from './planner-types.js';

test('real WASM preserves mapped occurrences unless explicitly opted in and composes finite PDF appearance (#4404)', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  const sourceUrl = new URL('../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  try { await Promise.all([access(wasmUrl), access(sourceUrl)]); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Run pnpm fixtures and pnpm build:wasm for the real evaluated appearance contract'); return;
  }
  const source = await readFile(sourceUrl);
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const api = new IfcAPI();
  const request: AppearanceRequest = { schema: 'IFC4', sourceRevision: 'AC20-wasm', nextExpressId: 100_000,
    productIds: [35169], imageUri: 'textures/evaluated.png', repeatS: true, repeatT: true,
    mapping: { kind: 'box', frame: 'world', origin: [0, 0, 0], metresPerTile: [1, 1, 1] } };
  let original: NonNullable<AppearancePlan['conversions']>[number] | undefined;
  try {
    const preserved = JSON.parse(new TextDecoder().decode(api.planAppearance(source, JSON.stringify(request)))) as AppearancePlan;
    assert.equal(preserved.items.length, 0); assert.equal(preserved.created.length, 0);
    request.representationPolicy = 'evaluatedOccurrence';
    const result = JSON.parse(new TextDecoder().decode(api.planAppearance(source, JSON.stringify(request)))) as AppearancePlan;
    assert.deepEqual(result.created.map(row => row.expressId), Array.from({ length: result.created.length }, (_, index) => result.nextExpressId + index));
    assert.equal(result.items.length, 1); assert.deepEqual(result.exclusions, []);
    assert.equal(result.conversions?.[0].productId, 35169);
    assert.equal(result.conversions?.[0].sourceGeometryItemId, 35135);
    assert.equal(result.conversions?.[0].sourceIndices.length, 36);
    original = result.conversions![0];
    assert.ok(original.sourcePositions?.length && original.sourceNormals?.length);
    assert.equal(original.sourcePositions.length, original.sourceNormals.length);
    assert.ok(original.sourceIndices.every(index => index < original!.sourcePositions!.length / 3));
    for (const values of [original.sourcePositions, original.sourceNormals, original.sourceOrigin, original.sourceColor, original.rtcOffset]) {
      assert.ok(values?.length); assert.ok(values.every(value => typeof value === 'number' && Number.isFinite(value)));
    }
    assert.deepEqual(original.rtcOffset, [0, 0, 0]);
    assert.ok(result.edits.every(edit => edit.expressId === 35155));
    assert.equal(result.items[0].geometryItemId, result.conversions?.[0].geometryItemId);
    assert.throws(() => api.planAppearance(source, JSON.stringify({ ...request, representationPolicy: 'silentlyFlatten' })), /unknown variant/);
  } finally { api.free(); }
  const { runPageAppearancePlanning } = await import('../../workers/appearance.worker.js');
  const page = await runPageAppearancePlanning(source, {
    appearance: { ...request, repeatS: false, repeatT: false,
      mapping: { kind: 'planar', frame: 'world', origin: [1, 6, 3], axisU: [0, 1, 0], axisV: [0, 0, 1], metresPerTile: [2, 2] } },
    page: { width: 1, height: 1, byteOffset: 0, byteLength: 4 }, sourceImages: [], texelsPerMetre: 32,
  }, new Uint8Array([255, 0, 0, 255]));
  assert.deepEqual(page.plan.created.map(row => row.expressId), Array.from({ length: page.plan.created.length }, (_, index) => page.plan.nextExpressId + index));
  assert.equal(page.itemImages[0].geometryItemId, page.plan.items[0].geometryItemId);
  assert.equal(page.plan.conversions?.length, 1); assert.ok(page.assets.length > 0);
  assert.ok(page.plan.edits.every(edit => edit.expressId === 35155));
  assert.ok(original);
  const converted = page.plan.conversions![0];
  for (const field of ['sourcePositions', 'sourceNormals', 'sourceOrigin', 'sourceColor', 'rtcOffset'] as const) {
    assert.deepEqual(converted[field], original[field], 'image and page reuse the same canonical original');
  }
});
