/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DownloadOptions } from './types.js';

/** Minimum gap between two intermediate progress reports: about 10 Hz. */
const PROGRESS_INTERVAL_MS = 100;

/** A byte count usable as a total: a finite, non-negative integer. */
function validTotal(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The response's own declared size, or `undefined` when it cannot be trusted
 * as the size of the bytes the body stream yields.
 *
 * `Content-Length` counts the bytes on the wire. When the response is
 * content-encoded (gzip, br) the stream yields the decoded bytes, so the two
 * disagree and a ring would pass 100%. Such a header is ignored.
 */
function declaredLength(response: Response): number | undefined {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') return undefined;
  const raw = response.headers.get('content-length');
  if (raw === null || !/^\s*\d+\s*$/.test(raw)) return undefined;
  return validTotal(Number(raw));
}

function concat(chunks: readonly Uint8Array[], byteLength: number): ArrayBuffer {
  const out = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * Reads a successful response body to an `ArrayBuffer`, reporting progress
 * through a provider's `DownloadOptions.onProgress` as the bytes arrive.
 *
 * The contract every caller can rely on:
 * - `received` never decreases between two calls.
 * - The first call is `(0, total)`, before any byte arrives, so a host can
 *   tell "started" from "queued".
 * - Intermediate calls are throttled to about 10 Hz
 *   ({@link PROGRESS_INTERVAL_MS}).
 * - The last call is `(byteLength, byteLength)` for the buffer returned.
 *
 * `total` is the response's `Content-Length` when present and usable, else
 * `fallbackTotal` (typically the listing's `SourceFile.sizeBytes`), else
 * `undefined`, in which case the host shows an indeterminate state. A total
 * the stream outgrows is dropped rather than reported below `received`.
 *
 * Without `onProgress` this is exactly `response.arrayBuffer()`.
 */
export async function readWithProgress(
  response: Response,
  onProgress: DownloadOptions['onProgress'],
  fallbackTotal?: number,
): Promise<ArrayBuffer> {
  if (!onProgress) return response.arrayBuffer();

  let total = declaredLength(response) ?? validTotal(fallbackTotal);
  onProgress(0, total);
  const body = response.body;
  if (!body) {
    // No stream to observe (a null-body response): the bytes arrive at once.
    const buffer = await response.arrayBuffer();
    onProgress(buffer.byteLength, buffer.byteLength);
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastReportAt = Date.now();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (total !== undefined && received > total) total = undefined;
      const now = Date.now();
      if (now - lastReportAt >= PROGRESS_INTERVAL_MS) {
        lastReportAt = now;
        onProgress(received, total);
      }
    }
  } catch (error) {
    // Release the connection when the failure is ours (a throwing
    // `onProgress`), not the stream's. A cancel on an already-errored stream
    // rejects with that same error, which is the one rethrown here, so the
    // secondary rejection carries nothing new and is dropped.
    reader.cancel(error).then(undefined, () => undefined);
    throw error;
  }
  onProgress(received, received);
  return concat(chunks, received);
}
