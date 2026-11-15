// SPDX-License-Identifier: MPL-2.0
import { decodeGaussianFile } from './gaussianDecode.js';
import { createGaussianDecodeSession, type GaussianDecodeRequest } from './gaussianDecodeSession.js';

// One capture per dedicated worker. Termination cancels both asynchronous reads
// and synchronous upstream decode; no shared worker can resurrect a removed asset.
// A bare File asks for the whole decode (export); a request object streams rows (#9018).
const session = createGaussianDecodeSession(decodeGaussianFile);
self.onmessage = async (event: MessageEvent<File | GaussianDecodeRequest>) => {
  if (!(event.data instanceof File)) {
    const { reply, transfer } = await session(event.data);
    self.postMessage(reply, { transfer });
    return;
  }
  try {
    const decoded = await decodeGaussianFile(event.data);
    const buffers = [...new Set(Object.values(decoded.columns).map(column => column.buffer))];
    self.postMessage({ ok: true, decoded }, { transfer: buffers });
  } catch (error) {
    self.postMessage({ ok: false, reason: error instanceof Error ? error.message : 'Gaussian decoding failed.' });
  }
};
