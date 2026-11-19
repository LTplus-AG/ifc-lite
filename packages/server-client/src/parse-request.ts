// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Compress a file or ArrayBuffer using gzip compression.
 * Uses the browser's CompressionStream API for efficient compression.
 *
 * @param file - File or ArrayBuffer to compress
 * @returns Compressed Blob
 */
export async function compressGzip(file: File | ArrayBuffer): Promise<Blob> {
  const stream = file instanceof File ? file.stream() : new Blob([file]).stream();
  const compressionStream = new CompressionStream('gzip');
  const compressedStream = stream.pipeThrough(compressionStream);
  return new Response(compressedStream).blob();
}

export async function compressedUploadForm(file: File | ArrayBuffer): Promise<FormData> {
  const form = new FormData();
  form.append('file', await compressGzip(file), file instanceof File ? file.name : 'model.ifc');
  return form;
}

export function parseRequestSignal(caller: AbortSignal | undefined, timeout: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeout);
  return caller ? AbortSignal.any([caller, deadline]) : deadline;
}
