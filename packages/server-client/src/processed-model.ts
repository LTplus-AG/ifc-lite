/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model the server has already processed, named by the SHA-256 of its source
 * file. `parseParquet` and `parseParquetStream` take one in place of a `File`
 * and return the stored result: nothing is hashed and nothing is uploaded. A
 * miss is an error, because there are no bytes to fall back to.
 *
 * The hash selects a stored result. It does not grant access to it; whoever
 * fronts the server decides who may ask.
 */
export interface ProcessedModelRef {
  /** SHA-256 of the source file as hex; case-insensitive, sent lowercase. */
  readonly sha256: string;
  /** Size of the source file in bytes. Not sent; callers use it to pick the streaming or one-shot route and to report a size. */
  readonly bytes: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The hash in the lowercase form the server keys results by, or `null` when it is not a SHA-256. */
export function normalizeProcessedModelHash(sha256: unknown): string | null {
  const lower = typeof sha256 === 'string' ? sha256.toLowerCase() : null;
  return lower !== null && SHA256_HEX.test(lower) ? lower : null;
}

/** The normalized hash, or a refusal before it is used: it becomes part of a request path. */
export function assertProcessedModelHash(sha256: unknown): string {
  const normalized = normalizeProcessedModelHash(sha256);
  if (normalized === null) {
    throw new TypeError('A processed model is named by the SHA-256 of its source file: 64 hex characters');
  }
  return normalized;
}

/** Tells a reference from the sources that carry bytes (`File`, `ArrayBuffer`). */
export function isProcessedModelRef(source: unknown): source is ProcessedModelRef {
  return typeof source === 'object' && source !== null
    && typeof (source as { sha256?: unknown }).sha256 === 'string'
    && typeof (source as { bytes?: unknown }).bytes === 'number';
}
