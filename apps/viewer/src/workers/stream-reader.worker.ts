/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SPIKE (streaming scan, `?streamScan=ab`): read the picked File into a
 * SharedArrayBuffer off the main thread, publishing how many bytes have landed
 * (an Int32 watermark, plus a progress message every PROGRESS_BYTES).
 *   start { file, sab, watermark } -> progress { bytes }* then done { bytes } | error { message }
 */

const PROGRESS_BYTES = 2 * 1024 * 1024;

self.onmessage = async (e: MessageEvent<{ type: 'start'; file: Blob; sab: SharedArrayBuffer; watermark: SharedArrayBuffer }>) => {
  const { file, sab, watermark } = e.data;
  const target = new Uint8Array(sab);
  const mark = new Int32Array(watermark);
  let offset = 0;
  let lastPosted = 0;
  try {
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > target.byteLength) throw new Error('file grew while reading');
      target.set(value, offset);
      offset += value.byteLength;
      Atomics.store(mark, 0, offset);
      if (offset - lastPosted >= PROGRESS_BYTES) {
        lastPosted = offset;
        (self as unknown as Worker).postMessage({ type: 'progress', bytes: offset });
      }
    }
    if (offset !== target.byteLength) throw new Error(`short read (got ${offset} of ${target.byteLength} bytes)`);
    Atomics.notify(mark, 0);
    (self as unknown as Worker).postMessage({ type: 'done', bytes: offset });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
