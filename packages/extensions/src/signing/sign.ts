/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bundle signing.
 *
 * `signBundle` takes an unsigned `Bundle` and a `KeyPair`, computes the
 * canonical content hash, signs it with the private key, and returns a
 * `SignatureBlock` ready to embed in the `.iflx` envelope.
 *
 * Verification lives in `./verify.ts` so the two paths can be reasoned
 * about independently. Both share the canonicalization in
 * `./canonical.ts`.
 *
 * Spec: docs/architecture/ai-customization/10-registry-and-signing.md.
 */

import { toBase64 } from './base64.js';
import { canonicalContentHash } from './canonical.js';
import type { Bundle } from '../types.js';
import type { KeyPair, SignatureBlock } from './types.js';

const ED25519_PARAMS = { name: 'Ed25519' } as const;

/**
 * Sign the bundle's canonical content with the keypair's private key.
 * Returns a SignatureBlock ready to embed in the .iflx envelope.
 *
 * `signedAt` defaults to `new Date().toISOString()`; pass an explicit
 * value for deterministic test output.
 */
export async function signBundle(
  bundle: Bundle,
  pair: KeyPair,
  opts: { signedAt?: string } = {},
): Promise<SignatureBlock> {
  const contentHash = await canonicalContentHash(bundle.files);
  const encoder = new TextEncoder();
  const message = encoder.encode(contentHash);
  const signature = new Uint8Array(
    await crypto.subtle.sign(ED25519_PARAMS, pair.privateKey, message.buffer.slice(0, message.byteLength) as ArrayBuffer),
  );
  return {
    algorithm: 'ed25519',
    contentHash,
    publicKey: toBase64(pair.publicKeyBytes),
    signature: toBase64(signature),
    signedAt: opts.signedAt ?? new Date().toISOString(),
  };
}
