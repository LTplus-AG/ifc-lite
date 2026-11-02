// SPDX-License-Identifier: MPL-2.0
import { decodeGaussianFile } from './gaussianDecode.js';

// One request per dedicated worker. Termination cancels both asynchronous reads
// and synchronous upstream decode; no shared worker can resurrect a removed asset.
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const decoded = await decodeGaussianFile(event.data);
    const buffers = [...new Set(Object.values(decoded.columns).map(column => column.buffer))];
    self.postMessage({ ok: true, decoded }, { transfer: buffers });
  } catch (error) {
    self.postMessage({ ok: false, reason: error instanceof Error ? error.message : 'Gaussian decoding failed.' });
  }
};
