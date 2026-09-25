/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ONE way the renderer creates a GPU buffer pre-filled with static
 * geometry (vertex, index and per-instance data) — issue #5429.
 *
 * Why `queue.writeBuffer` and never `createBuffer({ mappedAtCreation: true })`:
 * on Chromium (Chrome / Edge / WebView2, D3D12), a mapped-at-creation buffer
 * keeps a shared-memory copy of its FULL contents mapped into both the
 * renderer and the GPU process for as long as the buffer lives, even after
 * `unmap()`. That region is charged to system commit but appears in neither
 * process's private bytes, so a loaded scene carried an invisible second copy
 * of all its resident geometry (≈1.1 GB per 1 GiB uploaded in the issue's
 * standalone repro; ~6 GB for a 50-file federation). `writeBuffer` into a
 * plain `COPY_DST` buffer stages through a transient transfer allocation and
 * keeps nothing alive afterwards.
 *
 * It also removes this path's synchronous `RangeError` ("createBuffer failed,
 * size (…) is too large for the implementation when mappedAtCreation ==
 * true"): Chromium throws that only when it cannot back the mapping, and a
 * buffer created without `mappedAtCreation` has no mapping to back. A real
 * GPU out-of-memory still reports the way it always did for the device-side
 * allocation — asynchronously, as a `GPUOutOfMemoryError` through the
 * device's error scopes / `uncapturederror`.
 *
 * Alignment is this helper's job, not the caller's. `writeBuffer` throws an
 * `OperationError` DOMException when the byte count is not a multiple of 4,
 * and `gpu-upload-guard.ts`'s `isDeviceLossThrow` classifies EVERY
 * DOMException as a device loss — so one odd-length upload (a u16 index list
 * with an odd count, say) would falsely latch the whole session as lost.
 * The buffer size is therefore rounded up to 4 bytes (minimum 4), and an
 * unaligned payload is copied into a zero-padded staging array first. The
 * padding lies past every `indexCount` / vertex count the caller draws with,
 * so it is never read.
 *
 * `writeBuffer` copies `data` before it returns (WebGPU spec: the contents
 * are captured at call time), so callers may reuse or drop their CPU array
 * immediately, exactly as they could after `unmap()`.
 */
export function createStaticGpuBuffer(
  device: GPUDevice,
  data: ArrayBufferView | ArrayBuffer,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const size = alignedUploadSize(bytes.byteLength);
  const buffer = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
  if (bytes.byteLength === 0) return buffer;
  try {
    const payload = bytes.byteLength === size ? bytes : padTo(bytes, size);
    device.queue.writeBuffer(buffer, 0, payload);
  } catch (error) {
    // Never orphan the allocation: the caller only learns about buffers this
    // function RETURNS, so one that failed to fill is ours to release.
    buffer.destroy();
    throw error;
  }
  return buffer;
}

/** Byte size allocated for a payload of `byteLength`: 4-aligned, never 0. */
function alignedUploadSize(byteLength: number): number {
  return Math.max(4, Math.ceil(byteLength / 4) * 4);
}

function padTo(bytes: Uint8Array, size: number): Uint8Array {
  const padded = new Uint8Array(size);
  padded.set(bytes);
  return padded;
}
