/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Key generation, export, import, and fingerprinting.
 *
 * Uses WebCrypto's Ed25519 (available in Node ≥ 18.17 and modern
 * browsers — Chrome / Safari / Firefox 130+).
 *
 * Public keys export as raw 32 bytes. Private keys export as PKCS#8
 * (the only export format WebCrypto offers for Ed25519 private keys).
 * Both ride in base64 inside the JSON `.iflk` envelope.
 */

import { fromBase64, toBase64 } from './base64.js';
import { KeyFormatError } from './errors.js';
import type {
  KeyPair,
  SerialisedKey,
  SerialisedPrivateKey,
  SerialisedPublicKey,
  SigningAlgorithm,
} from './types.js';

const ALGORITHM: SigningAlgorithm = 'ed25519';
const ED25519_PARAMS = { name: 'Ed25519' } as const;

/**
 * Compute the fingerprint of a public key.
 *
 * SHA-256 of the raw 32-byte public key, rendered as colon-separated
 * pairs of lowercase hex characters. The full fingerprint is 64 hex
 * digits (32 pairs); UIs may display a prefix.
 */
export async function fingerprintFromBytes(publicKeyBytes: Uint8Array): Promise<string> {
  const buffer = publicKeyBytes.buffer.slice(
    publicKeyBytes.byteOffset,
    publicKeyBytes.byteOffset + publicKeyBytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return bytesToColonHex(new Uint8Array(digest));
}

/** Compact form (no colons). Useful for storage keys / map indexing. */
export function compactFingerprint(fp: string): string {
  return fp.replace(/:/g, '');
}

/** Generate a fresh Ed25519 keypair. */
export async function generateKeyPair(opts: { label?: string } = {}): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(
    ED25519_PARAMS,
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  );
  return {
    algorithm: ALGORITHM,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyBytes,
    fingerprint: await fingerprintFromBytes(publicKeyBytes),
    label: opts.label,
  };
}

/** Serialise a keypair into a private `.iflk` file. */
export async function exportPrivateKey(pair: KeyPair): Promise<SerialisedPrivateKey> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return {
    format: 'iflk',
    version: 1,
    kind: 'private',
    algorithm: ALGORITHM,
    privateKey: toBase64(pkcs8),
    publicKey: toBase64(pair.publicKeyBytes),
    label: pair.label,
    createdAt: new Date().toISOString(),
  };
}

/** Serialise the public half of a keypair into a public `.iflk` file. */
export function exportPublicKey(pair: KeyPair): SerialisedPublicKey {
  return {
    format: 'iflk',
    version: 1,
    kind: 'public',
    algorithm: ALGORITHM,
    publicKey: toBase64(pair.publicKeyBytes),
    label: pair.label,
    createdAt: new Date().toISOString(),
  };
}

/** Import a serialised `.iflk` (either public or private) back into a live key handle. */
export async function importKey(serialised: SerialisedKey): Promise<KeyPair | { publicKey: CryptoKey; publicKeyBytes: Uint8Array; fingerprint: string; label?: string; algorithm: SigningAlgorithm }> {
  validateKeyFile(serialised);
  if (serialised.kind === 'public') {
    return importPublicKey(serialised);
  }
  return importPrivateKey(serialised);
}

/** Import a public-key file. */
export async function importPublicKey(serialised: SerialisedPublicKey): Promise<{
  publicKey: CryptoKey;
  publicKeyBytes: Uint8Array;
  fingerprint: string;
  label?: string;
  algorithm: SigningAlgorithm;
}> {
  validateKeyFile(serialised);
  const publicKeyBytes = decodeRaw(serialised.publicKey, 32, 'publicKey');
  const buffer = publicKeyBytes.buffer.slice(
    publicKeyBytes.byteOffset,
    publicKeyBytes.byteOffset + publicKeyBytes.byteLength,
  ) as ArrayBuffer;
  const publicKey = await crypto.subtle.importKey(
    'raw',
    buffer,
    ED25519_PARAMS,
    true,
    ['verify'],
  );
  return {
    algorithm: ALGORITHM,
    publicKey,
    publicKeyBytes,
    fingerprint: await fingerprintFromBytes(publicKeyBytes),
    label: serialised.label,
  };
}

/** Import a private-key file. Returns a full KeyPair. */
export async function importPrivateKey(serialised: SerialisedPrivateKey): Promise<KeyPair> {
  validateKeyFile(serialised);
  const pkcs8 = fromBase64(serialised.privateKey);
  const pkcsBuffer = pkcs8.buffer.slice(
    pkcs8.byteOffset,
    pkcs8.byteOffset + pkcs8.byteLength,
  ) as ArrayBuffer;
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcsBuffer,
    ED25519_PARAMS,
    true,
    ['sign'],
  );
  const publicKeyBytes = decodeRaw(serialised.publicKey, 32, 'publicKey');
  const pubBuffer = publicKeyBytes.buffer.slice(
    publicKeyBytes.byteOffset,
    publicKeyBytes.byteOffset + publicKeyBytes.byteLength,
  ) as ArrayBuffer;
  const publicKey = await crypto.subtle.importKey(
    'raw',
    pubBuffer,
    ED25519_PARAMS,
    true,
    ['verify'],
  );
  return {
    algorithm: ALGORITHM,
    publicKey,
    privateKey,
    publicKeyBytes,
    fingerprint: await fingerprintFromBytes(publicKeyBytes),
    label: serialised.label,
  };
}

function validateKeyFile(serialised: SerialisedKey): void {
  if (typeof serialised !== 'object' || serialised === null) {
    throw new KeyFormatError('Key file must be a JSON object.');
  }
  if (serialised.format !== 'iflk') {
    throw new KeyFormatError(`Unexpected key format "${serialised.format}" (expected "iflk").`, 'format');
  }
  if (serialised.version !== 1) {
    throw new KeyFormatError(`Unsupported key file version ${serialised.version}.`, 'version');
  }
  if (serialised.algorithm !== ALGORITHM) {
    throw new KeyFormatError(`Unsupported algorithm "${serialised.algorithm}".`, 'algorithm');
  }
  if (serialised.kind !== 'public' && serialised.kind !== 'private') {
    throw new KeyFormatError(`Unknown key kind "${(serialised as { kind?: string }).kind}".`, 'kind');
  }
}

function decodeRaw(b64: unknown, expectedLength: number, field: string): Uint8Array {
  if (typeof b64 !== 'string') {
    throw new KeyFormatError(`Field "${field}" must be a base64 string.`, field);
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(b64);
  } catch (err) {
    throw new KeyFormatError(
      `Field "${field}" is not valid base64: ${err instanceof Error ? err.message : err}`,
      field,
    );
  }
  if (bytes.byteLength !== expectedLength) {
    throw new KeyFormatError(
      `Field "${field}" decoded to ${bytes.byteLength} bytes; expected ${expectedLength}.`,
      field,
    );
  }
  return bytes;
}

function bytesToColonHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += 1) {
    parts.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return parts.join(':');
}
