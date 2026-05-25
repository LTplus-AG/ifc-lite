/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packBundle, unpackBundle, unpackBundleWithSignature } from './iflx.js';
import { loadBundleFromDirectory } from './loader-node.js';
import { generateKeyPair } from '../signing/keys.js';
import { signBundle } from '../signing/sign.js';
import { verifyBundle } from '../signing/verify.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const GOOD_BUNDLE_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'bundles', 'good');

async function loadGood() {
  const r = await loadBundleFromDirectory(GOOD_BUNDLE_DIR);
  if (!r.ok) throw new Error('good bundle did not load');
  return r.value;
}

describe('signed .iflx round-trip', () => {
  it('packs with a signature and unpacks it back', async () => {
    const bundle = await loadGood();
    const pair = await generateKeyPair();
    const signature = await signBundle(bundle, pair, { signedAt: '2026-01-01' });

    const bytes = packBundle(bundle, signature);
    const result = unpackBundleWithSignature(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signature).toBeDefined();
    expect(result.value.signature?.algorithm).toBe('ed25519');
    expect(result.value.signature?.signedAt).toBe('2026-01-01');

    // Verifies against the original key.
    const info = await verifyBundle(result.value.bundle, result.value.signature!);
    expect(info.fingerprint).toBe(pair.fingerprint);
  });

  it('unsigned bundles produce undefined signature', async () => {
    const bundle = await loadGood();
    const bytes = packBundle(bundle);
    const result = unpackBundleWithSignature(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signature).toBeUndefined();
  });

  it('unpackBundle (no signature suffix) still works on signed bundles', async () => {
    // Backward-compat: existing call sites use unpackBundle and should
    // continue to work — the signature is silently ignored.
    const bundle = await loadGood();
    const pair = await generateKeyPair();
    const signature = await signBundle(bundle, pair);
    const bytes = packBundle(bundle, signature);
    const result = unpackBundle(bytes);
    expect(result.ok).toBe(true);
  });

  it('tampered packed bytes still detect the mismatch on verify', async () => {
    const bundle = await loadGood();
    const pair = await generateKeyPair();
    const signature = await signBundle(bundle, pair);
    const bytes = packBundle(bundle, signature);
    const result = unpackBundleWithSignature(bytes);
    if (!result.ok) throw new Error('expected ok');

    // Replace a file's bytes after unpacking but before verify.
    const file = result.value.bundle.files.get('src/activate.js');
    if (!file) throw new Error('fixture missing src/activate.js');
    file.bytes = new TextEncoder().encode('// tampered');
    file.text = '// tampered';

    await expect(
      verifyBundle(result.value.bundle, result.value.signature!),
    ).rejects.toThrow(/Content hash mismatch/);
  });
});
