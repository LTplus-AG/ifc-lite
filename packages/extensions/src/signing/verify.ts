/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Signature verification for `.iflx` bundles.
 *
 *   1. Recompute the canonical content hash from the bundle's file map.
 *   2. Check the hash matches `signature.contentHash` (catches local
 *      tampering before any crypto runs).
 *   3. Import the public key from the signature block and verify the
 *      ed25519 signature commits to the same content hash.
 *   4. Produce a `SignatureInfo` block with the fingerprint for UI /
 *      audit display.
 *
 * Throws `SignatureMismatchError` on any failure. Format problems with
 * the signature block surface as `SignatureFormatError`.
 *
 * Spec: docs/architecture/ai-customization/10-registry-and-signing.md §5.
 */

import { fromBase64 } from './base64.js';
import { canonicalContentHash } from './canonical.js';
import { SignatureFormatError, SignatureMismatchError } from './errors.js';
import { fingerprintFromBytes } from './keys.js';
import { buildSigningMessage } from './sign.js';
import type { Bundle } from '../types.js';
import type { SignatureBlock, SignatureInfo } from './types.js';

const ED25519_PARAMS = { name: 'Ed25519' } as const;

/** Verify a signature block against a bundle. */
export async function verifyBundle(
  bundle: Bundle,
  block: SignatureBlock,
): Promise<SignatureInfo> {
  validateBlockShape(block);

  // Recompute content hash and compare to the committed value.
  const actualHash = await canonicalContentHash(bundle.files);
  if (actualHash !== block.contentHash) {
    throw new SignatureMismatchError(
      `Content hash mismatch: bundle hashes to ${actualHash.slice(0, 16)}... but signature commits to ${block.contentHash.slice(0, 16)}...`,
    );
  }

  // Decode public key + signature.
  const publicKeyBytes = decodeOrThrow(block.publicKey, 32, 'publicKey');
  const signatureBytes = decodeOrThrow(block.signature, 64, 'signature');

  // Compute fingerprint up front so a future SignatureRevokedError can
  // surface the offending fingerprint to the caller.
  const fingerprint = await fingerprintFromBytes(publicKeyBytes);

  // Import the key and verify.
  const pubBuf = publicKeyBytes.buffer.slice(
    publicKeyBytes.byteOffset,
    publicKeyBytes.byteOffset + publicKeyBytes.byteLength,
  ) as ArrayBuffer;
  const publicKey = await crypto.subtle.importKey(
    'raw',
    pubBuf,
    ED25519_PARAMS,
    true,
    ['verify'],
  );
  // Re-derive the exact byte string the signer committed to. Includes
  // signedAt so post-sign tampering of that field is detected.
  const message = buildSigningMessage(block.contentHash, block.signedAt);
  const sigBuf = signatureBytes.buffer.slice(
    signatureBytes.byteOffset,
    signatureBytes.byteOffset + signatureBytes.byteLength,
  ) as ArrayBuffer;
  const msgBuf = message.buffer.slice(
    message.byteOffset,
    message.byteOffset + message.byteLength,
  ) as ArrayBuffer;
  const ok = await crypto.subtle.verify(ED25519_PARAMS, publicKey, sigBuf, msgBuf);
  if (!ok) {
    throw new SignatureMismatchError(
      'Signature verification failed: the signature does not commit to the bundle content under the given key.',
      { actualFingerprint: fingerprint },
    );
  }

  return {
    algorithm: 'ed25519',
    publicKeyBytes,
    fingerprint,
    contentHash: block.contentHash,
    signedAt: block.signedAt,
  };
}

function validateBlockShape(block: SignatureBlock): void {
  if (!block || typeof block !== 'object') {
    throw new SignatureFormatError('Signature block must be an object.');
  }
  if (block.algorithm !== 'ed25519') {
    throw new SignatureFormatError(`Unsupported signature algorithm "${block.algorithm}".`, 'algorithm');
  }
  for (const field of ['contentHash', 'publicKey', 'signature', 'signedAt'] as const) {
    if (typeof block[field] !== 'string' || (block[field] as string).length === 0) {
      throw new SignatureFormatError(`Signature field "${field}" must be a non-empty string.`, field);
    }
  }
}

function decodeOrThrow(b64: string, expectedLength: number, field: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(b64);
  } catch (err) {
    throw new SignatureFormatError(
      `Field "${field}" is not valid base64: ${err instanceof Error ? err.message : err}`,
      field,
    );
  }
  if (bytes.byteLength !== expectedLength) {
    throw new SignatureFormatError(
      `Field "${field}" decoded to ${bytes.byteLength} bytes; expected ${expectedLength}.`,
      field,
    );
  }
  return bytes;
}
