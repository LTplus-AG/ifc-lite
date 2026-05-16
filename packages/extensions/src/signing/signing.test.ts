/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  exportPrivateKey,
  exportPublicKey,
  fingerprintFromBytes,
  generateKeyPair,
  importPrivateKey,
  importPublicKey,
} from './keys.js';
import { canonicalContentHash } from './canonical.js';
import { signBundle } from './sign.js';
import { verifyBundle } from './verify.js';
import {
  KeyFormatError,
  SignatureFormatError,
  SignatureMismatchError,
} from './errors.js';
import type { Bundle, ExtensionManifest } from '../types.js';
import type { SignatureBlock } from './types.js';

function makeBundle(files: Record<string, string>): Bundle {
  const encoder = new TextEncoder();
  const map = new Map<string, { path: string; bytes: Uint8Array; text?: string }>();
  for (const [path, contents] of Object.entries(files)) {
    map.set(path, { path, bytes: encoder.encode(contents), text: contents });
  }
  const manifest: ExtensionManifest = {
    manifestVersion: 1,
    id: 'com.example.test',
    name: 'Test',
    description: 'test',
    version: '1.0.0',
    engines: { ifcLiteSdk: '>=0.0.0' },
    capabilities: [],
    activation: ['onStartup'],
    entry: {},
  };
  return { manifest, files: map, source: { kind: 'memory' } };
}

describe('generateKeyPair', () => {
  it('produces an ed25519 keypair with a fingerprint', async () => {
    const pair = await generateKeyPair();
    expect(pair.algorithm).toBe('ed25519');
    expect(pair.publicKeyBytes.byteLength).toBe(32);
    expect(pair.fingerprint).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){31}$/);
  });

  it('honours an optional label', async () => {
    const pair = await generateKeyPair({ label: 'Alice' });
    expect(pair.label).toBe('Alice');
  });

  it('produces distinct keys across calls', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('fingerprint format', () => {
  it('is 32 hex pairs', async () => {
    const pair = await generateKeyPair();
    const fp = await fingerprintFromBytes(pair.publicKeyBytes);
    expect(fp.split(':').length).toBe(32);
  });
});

describe('export / import — public', () => {
  it('round-trips public-only key file', async () => {
    const pair = await generateKeyPair({ label: 'pub' });
    const serialised = exportPublicKey(pair);
    expect(serialised.kind).toBe('public');
    const imported = await importPublicKey(serialised);
    expect(imported.fingerprint).toBe(pair.fingerprint);
    expect(imported.label).toBe('pub');
  });
});

describe('export / import — private', () => {
  it('round-trips private key file', async () => {
    const pair = await generateKeyPair({ label: 'priv' });
    const serialised = await exportPrivateKey(pair);
    expect(serialised.kind).toBe('private');
    const imported = await importPrivateKey(serialised);
    expect(imported.fingerprint).toBe(pair.fingerprint);
    expect(imported.label).toBe('priv');
  });

  it('imported private key produces matching signatures', async () => {
    const original = await generateKeyPair();
    const serialised = await exportPrivateKey(original);
    const imported = await importPrivateKey(serialised);
    const bundle = makeBundle({ 'manifest.json': '{}', 'src/x.js': 'hello' });
    const sig1 = await signBundle(bundle, original, { signedAt: 'X' });
    const sig2 = await signBundle(bundle, imported, { signedAt: 'X' });
    expect(sig1.signature).toBe(sig2.signature);
    expect(sig1.publicKey).toBe(sig2.publicKey);
  });
});

describe('import — error cases', () => {
  it('rejects bad format header', async () => {
    await expect(
      importPublicKey({
        format: 'wrong',
        version: 1,
        kind: 'public',
        algorithm: 'ed25519',
        publicKey: 'AAAA',
        createdAt: 'x',
      } as unknown as Parameters<typeof importPublicKey>[0]),
    ).rejects.toBeInstanceOf(KeyFormatError);
  });

  it('rejects unsupported algorithm', async () => {
    await expect(
      importPublicKey({
        format: 'iflk',
        version: 1,
        kind: 'public',
        algorithm: 'rsa' as 'ed25519',
        publicKey: 'AAAA',
        createdAt: 'x',
      }),
    ).rejects.toBeInstanceOf(KeyFormatError);
  });

  it('rejects wrong-length public key', async () => {
    await expect(
      importPublicKey({
        format: 'iflk',
        version: 1,
        kind: 'public',
        algorithm: 'ed25519',
        publicKey: 'AAAA',
        createdAt: 'x',
      }),
    ).rejects.toBeInstanceOf(KeyFormatError);
  });
});

describe('canonicalContentHash', () => {
  it('is deterministic for the same input', async () => {
    const a = makeBundle({ 'manifest.json': '{}', 'src/x.js': 'hi' });
    const b = makeBundle({ 'manifest.json': '{}', 'src/x.js': 'hi' });
    expect(await canonicalContentHash(a.files)).toBe(await canonicalContentHash(b.files));
  });

  it('changes when content changes', async () => {
    const a = makeBundle({ 'manifest.json': '{}', 'src/x.js': 'hi' });
    const b = makeBundle({ 'manifest.json': '{}', 'src/x.js': 'bye' });
    expect(await canonicalContentHash(a.files)).not.toBe(await canonicalContentHash(b.files));
  });

  it('changes when path changes', async () => {
    const a = makeBundle({ 'manifest.json': '{}', 'src/x.js': 'hi' });
    const b = makeBundle({ 'manifest.json': '{}', 'src/y.js': 'hi' });
    expect(await canonicalContentHash(a.files)).not.toBe(await canonicalContentHash(b.files));
  });

  it('is insensitive to insertion order', async () => {
    const a = makeBundle({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' });
    const b = new Map<string, { path: string; bytes: Uint8Array }>();
    const enc = new TextEncoder();
    b.set('c.txt', { path: 'c.txt', bytes: enc.encode('3') });
    b.set('a.txt', { path: 'a.txt', bytes: enc.encode('1') });
    b.set('b.txt', { path: 'b.txt', bytes: enc.encode('2') });
    expect(await canonicalContentHash(a.files)).toBe(await canonicalContentHash(b));
  });
});

describe('sign + verify — happy path', () => {
  it('verifies a freshly-signed bundle', async () => {
    const pair = await generateKeyPair();
    const bundle = makeBundle({ 'manifest.json': '{}', 'src/a.js': '1' });
    const sig = await signBundle(bundle, pair, { signedAt: 'now' });
    const info = await verifyBundle(bundle, sig);
    expect(info.fingerprint).toBe(pair.fingerprint);
    expect(info.contentHash).toBe(sig.contentHash);
  });

  it('signature commits to the recorded signedAt', async () => {
    const pair = await generateKeyPair();
    const bundle = makeBundle({ 'manifest.json': '{}' });
    const sig = await signBundle(bundle, pair, { signedAt: '2026-01-01' });
    expect(sig.signedAt).toBe('2026-01-01');
  });
});

describe('verify — tamper detection', () => {
  it('rejects modified content', async () => {
    const pair = await generateKeyPair();
    const bundle = makeBundle({ 'manifest.json': '{}', 'src/a.js': '1' });
    const sig = await signBundle(bundle, pair);

    // Tamper: modify a file after signing.
    const tamperedBundle = makeBundle({ 'manifest.json': '{}', 'src/a.js': '2' });
    await expect(verifyBundle(tamperedBundle, sig)).rejects.toBeInstanceOf(
      SignatureMismatchError,
    );
  });

  it('rejects tampered contentHash field', async () => {
    const pair = await generateKeyPair();
    const bundle = makeBundle({ 'manifest.json': '{}' });
    const sig = await signBundle(bundle, pair);
    // Replace the contentHash with a different valid-looking one.
    const tampered: SignatureBlock = {
      ...sig,
      contentHash: 'a'.repeat(64),
    };
    await expect(verifyBundle(bundle, tampered)).rejects.toBeInstanceOf(
      SignatureMismatchError,
    );
  });

  it('rejects a substituted signature from a different key', async () => {
    const alice = await generateKeyPair();
    const bundle = makeBundle({ 'manifest.json': '{}' });
    const aliceSig = await signBundle(bundle, alice);
    // Attacker substitutes a signature from a different key. Build a
    // signature with the attacker's key but the same contentHash.
    const mallory = await generateKeyPair();
    const evilSig: SignatureBlock = {
      ...aliceSig,
      publicKey: btoa(String.fromCharCode(...mallory.publicKeyBytes)),
      // signature still came from Alice → won't verify against mallory's key.
    };
    await expect(verifyBundle(bundle, evilSig)).rejects.toBeInstanceOf(
      SignatureMismatchError,
    );
  });
});

describe('verify — format errors', () => {
  it('rejects unknown algorithm', async () => {
    const pair = await generateKeyPair();
    const bundle = makeBundle({ 'manifest.json': '{}' });
    const sig = await signBundle(bundle, pair);
    const bad = { ...sig, algorithm: 'rsa' } as unknown as SignatureBlock;
    await expect(verifyBundle(bundle, bad)).rejects.toBeInstanceOf(SignatureFormatError);
  });

  it('rejects empty fields', async () => {
    const pair = await generateKeyPair();
    const bundle = makeBundle({ 'manifest.json': '{}' });
    const sig = await signBundle(bundle, pair);
    const bad = { ...sig, signature: '' } as SignatureBlock;
    await expect(verifyBundle(bundle, bad)).rejects.toBeInstanceOf(SignatureFormatError);
  });

  it('rejects wrong-length public key', async () => {
    const pair = await generateKeyPair();
    const bundle = makeBundle({ 'manifest.json': '{}' });
    const sig = await signBundle(bundle, pair);
    const bad = { ...sig, publicKey: 'AAAA' } as SignatureBlock;
    await expect(verifyBundle(bundle, bad)).rejects.toBeInstanceOf(SignatureFormatError);
  });
});
