/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { gzipSync } from 'fflate';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packBundle, unpackBundle } from './iflx.js';
import { loadBundleFromDirectory } from './loader.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const GOOD_BUNDLE_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'bundles', 'good');

async function loadGood() {
  const r = await loadBundleFromDirectory(GOOD_BUNDLE_DIR);
  if (!r.ok) throw new Error('expected good bundle to load');
  return r.value;
}

describe('packBundle / unpackBundle', () => {
  it('round-trips a bundle', async () => {
    const original = await loadGood();
    const packed = packBundle(original);
    expect(packed.length).toBeGreaterThan(0);
    const unpacked = unpackBundle(packed);
    expect(unpacked.ok).toBe(true);
    if (unpacked.ok) {
      expect(unpacked.value.manifest.id).toBe(original.manifest.id);
      expect(unpacked.value.files.size).toBe(original.files.size);
      for (const [path, file] of original.files) {
        const other = unpacked.value.files.get(path);
        expect(other?.bytes.byteLength).toBe(file.bytes.byteLength);
      }
    }
  });

  it('produces deterministic output for the same input', async () => {
    const original = await loadGood();
    const a = packBundle(original);
    const b = packBundle(original);
    expect(a.length).toBe(b.length);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  it('sets source kind to iflx after unpack', async () => {
    const original = await loadGood();
    const packed = packBundle(original);
    const unpacked = unpackBundle(packed);
    if (!unpacked.ok) throw new Error('expected ok');
    expect(unpacked.value.source?.kind).toBe('iflx');
  });
});

describe('unpackBundle — invalid inputs', () => {
  it('rejects garbage bytes', () => {
    const r = unpackBundle(new Uint8Array([1, 2, 3, 4, 5]));
    expect(r.ok).toBe(false);
  });

  it('rejects gzip with non-JSON payload', () => {
    const garbage = gzipSync(new TextEncoder().encode('not json'));
    const r = unpackBundle(garbage);
    expect(r.ok).toBe(false);
  });

  it('rejects envelope with wrong format', () => {
    const env = gzipSync(
      new TextEncoder().encode(JSON.stringify({ format: 'wrong', version: 1, files: {} })),
    );
    const r = unpackBundle(env);
    expect(r.ok).toBe(false);
  });

  it('rejects envelope with no files', () => {
    const env = gzipSync(
      new TextEncoder().encode(JSON.stringify({ format: 'iflx', version: 1, files: {} })),
    );
    const r = unpackBundle(env);
    expect(r.ok).toBe(false);
  });

  it('rejects envelope missing manifest.json', () => {
    const env = gzipSync(
      new TextEncoder().encode(JSON.stringify({
        format: 'iflx',
        version: 1,
        files: { 'README.md': Buffer.from('hi').toString('base64') },
      })),
    );
    const r = unpackBundle(env);
    expect(r.ok).toBe(false);
  });
});
