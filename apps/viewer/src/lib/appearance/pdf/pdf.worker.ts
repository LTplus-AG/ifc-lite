/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { runPdfJob, pdfError } from './engine.js';
import type { PdfWorkerRequest, PdfWorkerResponse } from './types.js';
self.onmessage = async (event: MessageEvent<PdfWorkerRequest>) => {
  const { id, source, password, job } = event.data;
  let response: PdfWorkerResponse;
  try {
    const { browserPdfBackend } = await import('./browser-backend.js');
    response = {
      id,
      result: await runPdfJob(browserPdfBackend(), source, job, { password }),
    };
  } catch (error) {
    const failure = pdfError(error);
    response = { id, error: { code: failure.code, message: failure.message } };
  }
  if ('result' in response && response.result.kind === 'raster')
    self.postMessage(response, { transfer: [response.result.png.buffer] });
  else self.postMessage(response);
};
