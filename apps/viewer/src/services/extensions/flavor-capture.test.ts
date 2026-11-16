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
it('shared native flavor capture survives the real portable archive codec with clash and layout evidence (#10525)', async () => {
  const host = new FlavorService({ storage: new InMemoryFlavorStorage() });
  const empty = createNativeFlavor('Portable native fixture', 'Capture proof', false); assert.equal(validateFlavor(empty).ok, true);
  const captured = captureNativeFlavor(empty); assert.equal(validateFlavor(captured).ok, true);
  await host.put(captured, 'native capture'); const archive = await host.exportFlavor(captured.id), unpacked = await host.preview(archive);
  assert.deepEqual(unpacked.flavor.layout, captured.layout); assert.deepEqual(unpacked.flavor.lenses, captured.lenses);
  assert.ok(unpacked.flavor.settings.clash); const config = deserializeClashConfig(unpacked.flavor.settings.clash);
  assert.ok(config); assert.equal(config.settings.tolerance, useViewerStore.getState().clashTolerance);
  assert.equal(await host.activeId(), undefined, 'packing and preview never activate an imported flavor');
});
