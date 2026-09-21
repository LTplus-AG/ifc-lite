/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { stripPageCrc } from '../formats/e57-page.js';
import { BlobByteSource } from './blob-source.js';

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** Read a bounded logical range from CRC-paged E57 storage. */
export async function readE57LogicalRange(
  src: BlobByteSource,
  logStart: number,
  logLength: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (logLength <= 0) return new Uint8Array(0);
  const payloadPerPage = pageSize - 4;
  const firstPage = Math.floor(logStart / payloadPerPage);
  const logicalPageStart = firstPage * payloadPerPage;
  const physicalStart = firstPage * pageSize;
  const logEnd = logStart + logLength;
  const lastPage = Math.floor((logEnd - 1) / payloadPerPage);
  const physical = await src.read(physicalStart, (lastPage + 1) * pageSize);
  throwIfAborted(signal);
  if (physical.length === 0) return new Uint8Array(0);
  const logical = stripPageCrc(physical, pageSize);
  const rel = logStart - logicalPageStart;
  if (rel >= logical.length) return new Uint8Array(0);
  return logical.subarray(rel, Math.min(rel + logLength, logical.length));
}
