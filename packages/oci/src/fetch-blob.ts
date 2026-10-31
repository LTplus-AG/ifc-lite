/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { finishDigest, readBody } from './digest.js';
import { OciError } from './errors.js';
import { isSha256Digest } from './reference.js';
import type { OciDescriptor, OciHasher } from './types.js';

/**
 * Checks a blob request before any byte moves: only sha256 can be verified,
 * and a descriptor that declares more than the caller's `maxBytes` fails
 * here instead of after a download the caller already said it won't take.
 */
export function checkBlobRequest(descriptor: OciDescriptor, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('@ifc-lite/oci: blob() maxBytes must be a non-negative integer');
  }
  if (!isSha256Digest(descriptor.digest)) {
    throw new OciError('PROTOCOL', `Blob descriptor digest "${descriptor.digest}" is not sha256:<64 hex>; it cannot be verified`);
  }
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
    throw new OciError('PROTOCOL', `Blob descriptor ${descriptor.digest} has an invalid size`);
  }
  if (descriptor.size > maxBytes) {
    throw new OciError(
      'SIZE_EXCEEDED',
      `Blob ${descriptor.digest} declares ${descriptor.size} bytes, above the ${maxBytes}-byte limit; not downloaded`,
    );
  }
}

/**
 * Streams a blob body into one buffer of exactly `descriptor.size` bytes
 * (the hard cap: the transfer is cancelled the moment it would overflow) and
 * verifies its sha256. With `createHasher` the hash is fed chunk by chunk as
 * bytes arrive; without, WebCrypto hashes the finished buffer in place, so
 * neither path makes a second full-size copy.
 */
export async function readVerifiedBlob(
  response: Response,
  descriptor: OciDescriptor,
  createHasher: (() => OciHasher) | undefined,
): Promise<Uint8Array> {
  const what = `blob ${descriptor.digest}`;
  const hasher = createHasher?.();
  const bytes = await readBody(response, {
    cap: descriptor.size,
    exact: true,
    what,
    onChunk: hasher ? (chunk) => hasher.update(chunk) : undefined,
  });
  const actual = await finishDigest(bytes, hasher);
  if (actual !== descriptor.digest) {
    throw new OciError('DIGEST_MISMATCH', `${what}: received bytes hash to ${actual}`);
  }
  return bytes;
}
