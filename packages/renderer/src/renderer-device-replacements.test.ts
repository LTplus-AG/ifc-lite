/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { diffCounters, perfCounters } from '@ifc-lite/load-trace';
import { Renderer } from './index.js';
import { meterGpuDevice } from './gpu-counters.js';

(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

function canvas(): HTMLCanvasElement {
  return { width: 64, height: 64, getBoundingClientRect: () => ({ width: 64, height: 64 }) } as unknown as HTMLCanvasElement;
}

/** A renderer whose device was lost, with GPU work stubbed (as renderer-device-recovery.test.ts). */
function lostRenderer(): Renderer {
  const renderer = new Renderer(canvas());
  renderer['deviceLost'] = true;
  renderer['deviceLostGeneration'] = renderer['initGeneration'];
  renderer['scene']['discardGpuResourcesForRecovery'] = () => {};
  renderer['scene']['restoreGpuResourcesAfterRecovery'] = () => {};
  renderer['refreshPlacementBounds'] = () => {};
  renderer['teardown'] = () => { renderer['ready'] = false; renderer['pipeline'] = null; };
  renderer['initOnce'] = async () => {
    renderer['pipeline'] = {} as never;
    const device = renderer['device'] as unknown as { device: GPUDevice; context: GPUCanvasContext };
    device.device = {} as GPUDevice;
    device.context = {} as GPUCanvasContext;
  };
  return renderer;
}

describe('gpu.deviceReplacements (#6993 review)', () => {
  it('counts a renderer rebuilding itself on a replacement device after a loss', async () => {
    perfCounters.enable();
    const before = perfCounters.read();
    const result = await lostRenderer().recoverDevice();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(diffCounters(perfCounters.read(), before)['gpu.deviceReplacements'], 1);
  });

  it('does not count two live renderers that each own one device', () => {
    // The viewport's renderer plus the appearance preview's: two devices, two
    // owners, no loss and no re-upload.
    perfCounters.enable();
    const before = perfCounters.read();
    for (const owner of [{}, {}]) {
      meterGpuDevice({ queue: { writeBuffer() {} }, createBuffer() {} } as unknown as GPUDevice, owner);
    }
    const delta = diffCounters(perfCounters.read(), before);
    assert.strictEqual(delta['gpu.devices'], 2);
    assert.strictEqual(delta['gpu.deviceReplacements'], undefined);
  });
});
