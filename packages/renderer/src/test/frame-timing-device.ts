/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CPU protocol oracle only: forbids use of mapped/destroyed buffers, controls map settlement. */
export function timingDevice() {
  (globalThis as Record<string, unknown>).GPUBufferUsage ??= { QUERY_RESOLVE: 512, COPY_SRC: 4, COPY_DST: 8, MAP_READ: 1 };
  (globalThis as Record<string, unknown>).GPUMapMode ??= { READ: 1 };
  const buffers: Array<{ memory: ArrayBuffer; pending: boolean; mapped: boolean; destroyed: boolean }> = [];
  let accept: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let resolves = 0;
  let submits = 0;
  let queryDestroyed = false;
  const device = {
    features: new Set(['timestamp-query']),
    createQuerySet: () => ({ destroy() { queryDestroyed = true; } }),
    createBuffer: ({ size }: GPUBufferDescriptor) => {
      const state = { memory: new ArrayBuffer(Number(size)), pending: false, mapped: false, destroyed: false };
      buffers.push(state);
      return {
        mapAsync() {
          if (state.pending || state.mapped || state.destroyed) throw new Error('invalid map lifetime');
          state.pending = true;
          return new Promise<void>((resolve, fail) => {
            accept = () => { state.pending = false; state.mapped = true; resolve(); };
            reject = fail;
          });
        },
        getMappedRange(offset = 0, size = state.memory.byteLength) {
          if (!state.mapped || state.destroyed) throw new Error('invalid mapped range lifetime');
          return state.memory.slice(offset, offset + size);
        },
        unmap() {
          if (state.pending) reject?.(new Error('map cancelled'));
          state.pending = false;
          state.mapped = false;
        },
        destroy() { state.destroyed = true; },
      };
    },
    queue: { submit() { submits++; } },
  } as unknown as GPUDevice;
  const encoder = () => ({
    resolveQuerySet() {
      if (queryDestroyed || buffers.some((buffer) => buffer.pending || buffer.mapped || buffer.destroyed)) {
        throw new Error('invalid query buffer reuse');
      }
      resolves++;
    },
    copyBufferToBuffer() { /* command encoding; timestamps supplied independently below */ },
    finish() { return {}; },
  }) as unknown as GPUCommandEncoder;
  return {
    device, encoder, buffers,
    resolves: () => resolves,
    submits: () => submits,
    queryDestroyed: () => queryDestroyed,
    settle(values = [1_000_000n, 3_000_000n]) {
      new BigInt64Array(buffers[1]!.memory).set(values);
      if (!accept) throw new Error('no pending map');
      accept();
    },
    fail() { reject?.(new Error('map failed')); },
  };
}
