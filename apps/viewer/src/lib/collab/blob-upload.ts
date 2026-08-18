/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Blob-upload resilience for the room seed.
 *
 * Split out of `geometry-sync.ts` so the transport policy (how many attempts,
 * how long to wait, when to stop) sits apart from what is being uploaded.
 * Sizing here comes from the production failure it exists for: the blob volume
 * ran out of inodes and refused EVERY write, so a policy that retries
 * everything turns a 300k-mesh share into ~900k doomed requests and makes the
 * user wait through all of them before hearing about it.
 */

import type { BlobStore } from '@ifc-lite/collab';

export const DEFAULT_UPLOAD_RETRIES = 2;
export const DEFAULT_UPLOAD_RETRY_DELAYS_MS = [150, 600] as const;
export const DEFAULT_UPLOAD_MAX_FAILURES = 10;

/**
 * Numeric-option guard. A NaN or negative override must fall back to the
 * default rather than silently switching off the protection it configures:
 * `failures >= NaN` is false forever, which is no circuit breaker at all.
 */
export function uploadCountOption(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

const delay = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * One blob, with bounded retries. A single transient 5xx on one of thousands
 * of blobs must not decide the fate of the whole share.
 */
export async function putBlobWithRetry(
  blobStore: BlobStore,
  bytes: Uint8Array,
  retries: number,
  delaysMs: readonly number[],
): Promise<{ hash: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await blobStore.put(bytes, 'application/octet-stream');
    } catch (err) {
      lastError = err;
      if (attempt < retries) await delay(delaysMs[attempt] ?? delaysMs[delaysMs.length - 1] ?? 0);
    }
  }
  throw lastError;
}
