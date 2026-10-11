/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { perfCount, perfCounters } from '@ifc-lite/load-trace';

/** `GPUBufferUsage.UNIFORM`, inlined so this module loads where WebGPU globals don't exist. */
const UNIFORM = 0x40;

/**
 * GPU upload counters (#6957), installed once on the device so every
 * `createBuffer` / `queue.writeBuffer` in the renderer is counted without
 * touching its call sites:
 *
 *   gpu.buffers                 buffers created
 *   gpu.bufferBytes             their total size
 *   gpu.mappedUploadBytes       bytes of buffers created `mappedAtCreation` (filled on the CPU)
 *   gpu.writeBytes              `writeBuffer` bytes into non-uniform buffers (geometry, ids, ...)
 *   gpu.uniformWriteBytes       `writeBuffer` bytes into uniform buffers; per frame, so
 *                               timing-dependent, kept apart from the structural counts
 *
 * and the device's health (#6993), so a benchmark sample can tell a load that
 * lost its device (and re-uploaded everything onto a replacement) from a
 * clean one instead of averaging the two:
 *
 *   gpu.devices                 devices metered, across every live renderer
 *   gpu.deviceReplacements      counted by `device-recovery.ts`: a renderer rebuilding
 *                               itself on a replacement device after a loss, which
 *                               re-uploads its scene (two live renderers are not one)
 *   gpu.deviceLost              `device.lost` settled for any reason but `destroyed`
 *   gpu.uncapturedErrors        `uncapturederror` events (validation / out-of-memory)
 *
 * `owner` is whoever replaces the device on recovery (the `WebGPUDevice`
 * wrapper): a late loss of a device its owner has since replaced is ignored.
 *
 * Counters off: returns the device untouched.
 */
export function meterGpuDevice(device: GPUDevice, owner: object = device): GPUDevice {
  if (!perfCounters.enabled) return device;
  meterDeviceHealth(device, owner);
  const createBuffer = device.createBuffer.bind(device);
  device.createBuffer = (descriptor: GPUBufferDescriptor) => {
    perfCount('gpu.buffers');
    perfCount('gpu.bufferBytes', descriptor.size);
    if (descriptor.mappedAtCreation) perfCount('gpu.mappedUploadBytes', descriptor.size);
    return createBuffer(descriptor);
  };
  const queue = device.queue;
  const writeBuffer = queue.writeBuffer.bind(queue) as (...args: unknown[]) => void;
  queue.writeBuffer = ((buffer: GPUBuffer, offset: number, data: BufferSource | SharedArrayBuffer, dataOffset?: number, size?: number) => {
    const elementBytes = ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data ? (data as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT : 1;
    const total = data.byteLength - (dataOffset ?? 0) * elementBytes;
    const bytes = size !== undefined ? size * elementBytes : total;
    perfCount((buffer.usage & UNIFORM) !== 0 ? 'gpu.uniformWriteBytes' : 'gpu.writeBytes', bytes);
    writeBuffer(buffer, offset, data, dataOffset, size);
  }) as GPUQueue['writeBuffer'];
  return device;
}

/**
 * Lifetime of each owner's newest metered device, per owner (the
 * `WebGPUDevice` wrapper), mirroring its own `deviceLifetime` (device.ts).
 * Per owner, not module-wide: two renderers live at once (the appearance
 * preview creates a second one) each have a current device to lose.
 */
const deviceLifetimes = new WeakMap<object, number>();

/** See `meterGpuDevice`. Listens beside the renderer's own handlers, never replacing them. */
function meterDeviceHealth(device: GPUDevice, owner: object): void {
  const lifetime = (deviceLifetimes.get(owner) ?? 0) + 1;
  deviceLifetimes.set(owner, lifetime);
  perfCount('gpu.devices');
  // Both are optional on test doubles and older runtimes.
  const lost = (device as { lost?: Promise<{ reason?: string }> }).lost;
  void lost?.then((info) => {
    // A device its own owner has since replaced settling late is not a loss
    // of the device in use, exactly as the renderer ignores it.
    if (deviceLifetimes.get(owner) !== lifetime) return;
    if ((info.reason ?? 'unknown') !== 'destroyed') perfCount('gpu.deviceLost');
  });
  if (typeof device.addEventListener === 'function') {
    device.addEventListener('uncapturederror', () => perfCount('gpu.uncapturedErrors'));
  }
}
