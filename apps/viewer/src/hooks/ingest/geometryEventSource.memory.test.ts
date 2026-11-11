/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Huge-file stage 1 (#9659): the exact kernel refuses a load only when even
 * the source copies the path that will run must hold exceed what the
 * browser's `deviceMemory` reading allows, before a byte of the file is read.
 * Retry tries the same file anyway. The memory simulation flag never refuses.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { createModelLoadActivity } from '../modelLoadCanceller.js';
import { beginGeometryKernel } from './geometryEventSource.js';

const SIMULATED = '__IFC_LITE_GEOM_MEMORY_GB';
const nav = globalThis.navigator as Navigator & { deviceMemory?: number };
const originalDeviceMemory = Object.getOwnPropertyDescriptor(nav, 'deviceMemory');

function reportMemory(gb: number | undefined): void {
  Object.defineProperty(nav, 'deviceMemory', { value: gb, configurable: true });
}

/** A File whose reported size is `bytes` without allocating them. */
function stepFile(name: string, bytes: number): File {
  const file = new File(['ISO-10303-21;\nEND-ISO-10303-21;\n'], name);
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SIMULATED];
  if (originalDeviceMemory) Object.defineProperty(nav, 'deviceMemory', originalDeviceMemory);
  else Reflect.deleteProperty(nav, 'deviceMemory');
  useViewerStore.getState().setError(null);
  useViewerStore.getState().clearAllModels();
});

describe('exact kernel memory refusal', () => {
  it('refuses a .ifc whose source copies cannot fit the reading, up front, and Retry tries it anyway', async () => {
    reportMemory(1); // at most 1.5 GiB; even the serial fallback holds 2 × 1 GiB
    const file = stepFile('big.ifc', 1024 ** 3);
    let retried = 0;
    const kernel = beginGeometryKernel(file, { kind: 'primary' }, () => { retried++; });
    assert.equal(kernel.kind, 'exact');
    const message = await kernel.refused;
    assert.match(message ?? '', /needs at least .* more than this device reports/);
    assert.equal(useViewerStore.getState().error, message);
    const tryAnyway = useViewerStore.getState().lastLoadRetry;
    assert.equal(typeof tryAnyway, 'function');
    tryAnyway?.();
    assert.equal(retried, 1);
    // The retried load of the same file is not refused again.
    assert.equal(beginGeometryKernel(file, { kind: 'primary' }, () => {}).refused, undefined);
  });

  it('nothing is refused when the reading is unknown or possibly clamped (8, 32)', () => {
    for (const gb of [undefined, 8, 32]) {
      reportMemory(gb);
      const kernel = beginGeometryKernel(stepFile('big.ifc', 2047 * 1024 ** 2), { kind: 'primary' }, () => {});
      assert.equal(kernel.refused, undefined, String(gb));
    }
  });

  it('the memory simulation flag cannot refuse a load', () => {
    // A 1 GiB source: its 2–3 GiB copy floor would exceed any ceiling derived
    // from a 0.001 GiB simulation (≤ 1.5 MiB), so this fails if the simulation
    // ever feeds the refusal (review on #9659).
    reportMemory(32);
    (globalThis as Record<string, unknown>)[SIMULATED] = 0.001;
    const kernel = beginGeometryKernel(stepFile('big.ifc', 1024 ** 3), { kind: 'primary' }, () => {});
    assert.equal(kernel.refused, undefined);
  });

  it('an .ifczip is measured after unwrapping: refuseSource marks the model and reports', () => {
    reportMemory(1);
    const kernel = beginGeometryKernel(stepFile('big.ifczip', 1024), { kind: 'primary' }, () => {});
    assert.equal(kernel.refused, undefined);
    useViewerStore.getState().addModel({
      id: 'z', name: 'big.ifczip', ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
      schemaVersion: 'IFC4', loadedAt: 0, fileSize: 0, idOffset: 0, maxExpressId: 0, loadState: 'streaming-geometry',
    });
    const activity = createModelLoadActivity('big.ifczip');
    assert.equal(kernel.refuseSource('ifc', 1024 ** 3, { modelId: 'z', activity }), true);
    assert.equal(useViewerStore.getState().models.get('z')?.loadState, 'error');
    assert.match(useViewerStore.getState().error ?? '', /more than this device reports/);
    assert.equal(kernel.refuseSource('ifc', 1024, { modelId: 'z', activity }), false);
    assert.equal(kernel.refuseSource('las', 1024 ** 3, { modelId: 'z', activity }), false);
  });
});
