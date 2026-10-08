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
 * Counters off: returns the device untouched.
 */
export function meterGpuDevice(device: GPUDevice): GPUDevice {
  if (!perfCounters.enabled) return device;
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
