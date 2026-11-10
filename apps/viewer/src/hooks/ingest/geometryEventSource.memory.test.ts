/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Huge-file stage 1: the exact kernel refuses a load whose whole-tab memory
 * estimate for one geometry worker exceeds what the device can have, before
 * a byte of the file is read. `__IFC_LITE_GEOM_MEMORY_GB` simulates the
 * device (0.25 GiB is below the model's fixed cost, so any file is refused).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { createModelLoadActivity } from '../modelLoadCanceller.js';
import { beginGeometryKernel } from './geometryEventSource.js';

const SIMULATED = '__IFC_LITE_GEOM_MEMORY_GB';
const stepFile = (name: string) => new File(['ISO-10303-21;\nEND-ISO-10303-21;\n'], name);

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SIMULATED];
  useViewerStore.getState().setError(null);
  useViewerStore.getState().clearAllModels();
});

describe('exact kernel memory refusal', () => {
  it('a .ifc that cannot fit one worker is refused up front with the device-memory message and no Retry', async () => {
    (globalThis as Record<string, unknown>)[SIMULATED] = 0.25;
    const kernel = beginGeometryKernel(stepFile('big.ifc'), { kind: 'primary' }, () => assert.fail('must not retry'));
    assert.equal(kernel.kind, 'exact');
    const message = await kernel.refused;
    assert.match(message ?? '', /more than this device or browser can provide/);
    assert.equal(useViewerStore.getState().error, message);
    assert.equal(useViewerStore.getState().lastLoadRetry, null);
  });

  it('nothing is refused when the device fits (or its memory is unknown)', () => {
    const kernel = beginGeometryKernel(stepFile('small.ifc'), { kind: 'primary' }, () => {});
    assert.equal(kernel.refused, undefined);
    assert.equal(kernel.refuseSource('ifc', 1024, { modelId: 'm', activity: createModelLoadActivity('small.ifc') }), false);
  });

  it('an .ifczip is measured after unwrapping: refuseSource marks the model and reports', () => {
    (globalThis as Record<string, unknown>)[SIMULATED] = 0.25;
    const kernel = beginGeometryKernel(stepFile('big.ifczip'), { kind: 'primary' }, () => {});
    assert.equal(kernel.refused, undefined);
    useViewerStore.getState().addModel({
      id: 'z', name: 'big.ifczip', ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
      schemaVersion: 'IFC4', loadedAt: 0, fileSize: 0, idOffset: 0, maxExpressId: 0, loadState: 'streaming-geometry',
    });
    assert.equal(kernel.refuseSource('ifc', 1024, { modelId: 'z', activity: createModelLoadActivity('big.ifczip') }), true);
    assert.equal(useViewerStore.getState().models.get('z')?.loadState, 'error');
    assert.match(useViewerStore.getState().error ?? '', /more than this device/);
    assert.equal(kernel.refuseSource('las', 1024, { modelId: 'z', activity: createModelLoadActivity('big.ifczip') }), false);
  });
});
