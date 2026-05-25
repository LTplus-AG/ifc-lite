/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Public types for `@ifc-lite/extensions/signing`.
 *
 * Spec: docs/architecture/ai-customization/10-registry-and-signing.md.
 */

/** Algorithm identifier embedded in signed envelopes / key files. */
export type SigningAlgorithm = 'ed25519';

/** Roles a key file can play. */
export type KeyKind = 'public' | 'private';

/**
 * Serialised key file shape (`.iflk`). Public and private key files
 * share a header for inspectability; the discriminator is `kind`.
 */
export interface SerialisedPublicKey {
  format: 'iflk';
  version: 1;
  kind: 'public';
  algorithm: SigningAlgorithm;
  /** Raw 32-byte Ed25519 public key, base64-encoded. */
  publicKey: string;
  /** Optional human-readable label. Display-only. */
  label?: string;
  /** ISO timestamp of key generation. */
  createdAt: string;
}

export interface SerialisedPrivateKey {
  format: 'iflk';
  version: 1;
  kind: 'private';
  algorithm: SigningAlgorithm;
  /** PKCS#8 private key, base64-encoded. */
  privateKey: string;
  /** Raw public key for convenience (avoids re-derivation on load). */
  publicKey: string;
  label?: string;
  createdAt: string;
}

export type SerialisedKey = SerialisedPublicKey | SerialisedPrivateKey;

/** A live keypair. The CryptoKey objects are usable with WebCrypto. */
export interface KeyPair {
  algorithm: SigningAlgorithm;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** Raw 32-byte public key bytes — useful for hashing/fingerprinting. */
  publicKeyBytes: Uint8Array;
  /** Fingerprint of the public key. See `fingerprint()`. */
  fingerprint: string;
  /** Optional label that travels with the key file. */
  label?: string;
}

/**
 * Signature block embedded in a signed `.iflx` envelope.
 *
 * The block commits to a `contentHash` (canonical hash of the bundle's
 * files, excluding the signature block itself) so verifiers can
 * recompute the same hash independently.
 */
export interface SignatureBlock {
  algorithm: SigningAlgorithm;
  /** Hex SHA-256 of the canonical content. */
  contentHash: string;
  /** Raw 32-byte public key, base64. */
  publicKey: string;
  /** 64-byte detached signature, base64. */
  signature: string;
  /** ISO timestamp the signer recorded at sign time. */
  signedAt: string;
}

/**
 * Result of verifying a signed envelope. Returned by `verifyBundle`
 * and surfaced by the loader so UI / audit log can record the
 * signer.
 */
export interface SignatureInfo {
  algorithm: SigningAlgorithm;
  /** Raw 32-byte public key bytes. */
  publicKeyBytes: Uint8Array;
  /** Display fingerprint (hex pairs joined by ":"). */
  fingerprint: string;
  /** Hex SHA-256 of the canonical content this signature commits to. */
  contentHash: string;
  /** ISO timestamp recorded at sign time. */
  signedAt: string;
}
