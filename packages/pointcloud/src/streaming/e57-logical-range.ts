/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { stripPageCrc } from '../formats/e57-page.js';
import { BlobByteSource } from './blob-source.js';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** Read a bounded logical range from CRC-paged E57 storage.
 *
 * `BlobByteSource.read` silently clamps to the blob's actual size (see its
 * doc comment) — a file whose header/XML declares a longer logical range
 * than the body backs (a truncated download, an interrupted upload) yields
 * a SHORT slice here with no error. Most callers tolerate that: the
 * CompressedVector point-data window in `E57StreamingSource.next()` treats
 * a short/empty window as "no more bytes for this scan" and trims its
 * output instead of fabricating points — the same documented policy as an
 * over-reported `recordCount` (see that class's `next()`). Passing
 * `{ strict: true }` opts a caller OUT of that tolerance: it asserts the
 * full requested range was actually read and throws, naming expected vs.
 * actual byte counts, otherwise. Use it for control-plane reads (the XML
 * metadata section) where a short read must be reported as truncation
 * rather than silently absorbed — see `E57StreamingSource.open()` and
 * `inspectE57SpatialMetadata`, the two callers that pass it.
 */
export async function readE57LogicalRange(
  src: BlobByteSource,
  logStart: number,
  logLength: number,
  pageSize: number,
  signal?: AbortSignal,
  options?: { strict?: boolean },
): Promise<Uint8Array> {
  throwIfAborted(signal);
  // A NaN offset or length compares false against every bound below, so it
  // would fall through as a "successful" empty read, even in strict mode.
  if (!Number.isFinite(logStart) || !Number.isFinite(logLength)) {
    throw new Error(`E57: invalid logical range (offset ${logStart}, length ${logLength})`);
  }
  if (logLength <= 0) return new Uint8Array(0);
  const payloadPerPage = pageSize - 4;
  const firstPage = Math.floor(logStart / payloadPerPage);
  const logicalPageStart = firstPage * payloadPerPage;
  const physicalStart = firstPage * pageSize;
  const logEnd = logStart + logLength;
  const lastPage = Math.floor((logEnd - 1) / payloadPerPage);
  const physical = await src.read(physicalStart, (lastPage + 1) * pageSize);
  throwIfAborted(signal);
  const logical = physical.length === 0 ? new Uint8Array(0) : stripPageCrc(physical, pageSize);
  const rel = logStart - logicalPageStart;
  const result = rel >= logical.length
    ? new Uint8Array(0)
    : logical.subarray(rel, Math.min(rel + logLength, logical.length));
  if (options?.strict && result.length < logLength) {
    throw new Error(
      `E57: logical range read expects ${logLength} bytes at logical offset ${logStart}, `
      + `got ${result.length} — file truncated?`,
    );
  }
  return result;
}
