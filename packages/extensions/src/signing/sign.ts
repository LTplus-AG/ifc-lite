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
 * `./canonical.ts` and the message construction below.
 *
 * Spec: docs/architecture/ai-customization/10-registry-and-signing.md.
 */

import { toBase64 } from './base64.js';
import { canonicalContentHash } from './canonical.js';
import type { Bundle } from '../types.js';
import type { KeyPair, SignatureBlock } from './types.js';

const ED25519_PARAMS = { name: 'Ed25519' } as const;

/**
 * Build the byte string the signer commits to.
 *
 * Includes both `contentHash` and `signedAt` so neither can be tampered
 * after signing. Format is `iflx-sig\x1f v1 \x1f <contentHash> \x1f <signedAt>`
 * — fixed prefix + version + ASCII unit separator (`0x1f`) between
 * fields. The prefix isolates this scheme from any other Ed25519
 * signing convention that might reuse the same key in the wild.
 */
export function buildSigningMessage(contentHash: string, signedAt: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`iflx-sig\x1fv1\x1f${contentHash}\x1f${signedAt}`);
}

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
  const signedAt = opts.signedAt ?? new Date().toISOString();
  const message = buildSigningMessage(contentHash, signedAt);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      ED25519_PARAMS,
      pair.privateKey,
      message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer,
    ),
  );
  return {
    algorithm: 'ed25519',
    contentHash,
    publicKey: toBase64(pair.publicKeyBytes),
    signature: toBase64(signature),
    signedAt,
  };
}
