/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { getPdfDocument } from './pdf/documents';
import { publishPdfRaster } from './pdf/publish-source';
import type { PdfRasterRequest } from './pdf/types';
/** The native UI and agent share PDF recipe execution and ownership transfer.
 * A refused publication releases the provisional native raster deterministically. */
export async function rasterNativePdfSource(
  documentKey: string,
  request: PdfRasterRequest,
  options: { signal: AbortSignal; isCurrent?: () => boolean; commit?: <T>(write: () => T) => T },
) {
  const document = getPdfDocument(documentKey);
  if (!document) throw new Error('The original PDF is unavailable. Import the document again.');
  const result = await document.rasterize(request, { signal: options.signal });
  let admitted = false;
  try {
    options.signal.throwIfAborted();
    if (options.isCurrent && !options.isCurrent()) throw new Error('The PDF recipe/source changed before publication.');
    const write = () => {
      options.signal.throwIfAborted();
      if (options.isCurrent && !options.isCurrent())
        throw new Error('The PDF recipe/source changed before publication.');
      admitted = true;
      return publishPdfRaster(documentKey, result);
    };
    return options.commit ? options.commit(write) : write();
  } finally {
    if (!admitted) document.releaseRaster(result.asset.id);
  }
}
