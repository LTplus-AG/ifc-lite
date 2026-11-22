/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { InMemoryFlavorStorage, validateFlavor } from '@ifc-lite/extensions';
import { FlavorService } from './flavor-service';
import { createNativeFlavor, captureNativeFlavor } from './flavor-capture';
import { deserializeClashConfig } from '@/lib/clash/persistence.flavor';
import { useViewerStore } from '@/store';
it('shared native flavor capture survives the real portable archive codec with clash and layout evidence (#10525, #10591)', async () => {
  const host = new FlavorService({ storage: new InMemoryFlavorStorage() });
  const empty = createNativeFlavor('Clash - Review', 'Capture proof', false); assert.equal(validateFlavor(empty).ok, true);
  const captured = captureNativeFlavor(empty); assert.equal(validateFlavor(captured).ok, true);
  await host.put(captured, 'native capture'); const archive = await host.exportFlavor(captured.id), unpacked = await host.preview(archive);
  assert.deepEqual(unpacked.flavor.layout, captured.layout); assert.deepEqual(unpacked.flavor.lenses, captured.lenses);
  assert.ok(unpacked.flavor.settings.clash); const config = deserializeClashConfig(unpacked.flavor.settings.clash);
  assert.ok(config); assert.equal(config.settings.tolerance, useViewerStore.getState().clashTolerance);
  assert.equal(await host.activeId(), undefined, 'packing and preview never activate an imported flavor');
});
it('capturing an older flavor saved without a layout adds the sidebar layout (#10591 review)', () => {
  const legacy = { ...createNativeFlavor('Legacy fixture', '', false), layout: undefined } as unknown as Parameters<typeof captureNativeFlavor>[0];
  const captured = captureNativeFlavor(legacy);
  assert.ok(captured.layout.state.sidebar, 'the sidebar layout is captured');
});

it('keeps both same-millisecond creations and loads a legacy flavor ID (#10591)', async (t) => {
  const now = '2026-11-16T12:00:00.000Z';
  t.mock.timers.enable({ apis: ['Date'], now: new Date(now) });
  const host = new FlavorService({ storage: new InMemoryFlavorStorage() });
  const first = createNativeFlavor('Review', '', false);
  const second = createNativeFlavor('Review', '', false);
  assert.equal(first.createdAt, now);
  assert.equal(second.createdAt, now);
  const legacy = { ...first, id: 'local.review.2026-11-16t12-00-00-000z' };
  for (const flavor of [first, second, legacy]) {
    assert.equal(validateFlavor(flavor).ok, true);
    await host.put(flavor, 'native capture');
  }
  assert.equal((await host.list()).length, 3);
  assert.equal((await host.preview(await host.exportFlavor(legacy.id))).flavor.id, legacy.id);
});
