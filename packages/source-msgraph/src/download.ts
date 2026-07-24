/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Reads a `Response` body to completion, reporting progress when both a reader and a caller callback are available. */
export async function readResponseBody(
  response: Response,
  onProgress?: (received: number, total?: number) => void,
): Promise<ArrayBuffer> {
  if (!onProgress || !response.body) {
    return response.arrayBuffer();
  }

  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress(received, Number.isFinite(total) ? total : undefined);
    }
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
