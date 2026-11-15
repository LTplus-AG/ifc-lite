// SPDX-License-Identifier: MPL-2.0
import { decodeGaussianFile } from './gaussianDecode.js';
import { createGaussianDecodeSession, GAUSSIAN_STREAM_ROWS, type GaussianDecodeRequest } from './gaussianDecodeSession.js';
import { openGaussianDecodeStream } from './gaussianDecodeStream.js';
import { gaussianSummaryHelpers } from './gaussianSummaryHelpers.js';

// One capture per dedicated worker. Termination cancels both asynchronous reads
// and synchronous upstream decode; no shared worker can resurrect a removed asset.
// A bare File asks for the whole decode (export); a request object streams rows from
// range reads of the File, never holding the whole capture (#9018). The summary pass
// runs in parallel in helper workers this worker owns (terminated with it).
const session = createGaussianDecodeSession((file, summary) => openGaussianDecodeStream(file, GAUSSIAN_STREAM_ROWS, summary, gaussianSummaryHelpers(file)));
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
