// SPDX-License-Identifier: MPL-2.0
import { GAUSSIAN_STREAM_ROWS } from './gaussianDecodeSession.js';
import { summarizeGaussianRange } from './gaussianDecodeStream.js';

// #9018 helper of the Gaussian decode worker, spawned and terminated by it: validates
// and summarizes one range of the capture so the summary pass runs in parallel. It is
// never created by the page, so terminating the decode worker ends it too.
self.onmessage = async (event: MessageEvent<{ file: File; start: number; end: number }>) => {
  try {
    const { file, start, end } = event.data;
    self.postMessage({ ok: true, part: await summarizeGaussianRange(file, GAUSSIAN_STREAM_ROWS, start, end) });
  } catch (error) {
    self.postMessage({ ok: false, reason: error instanceof Error ? error.message : 'Gaussian decoding failed.' });
  }
};
