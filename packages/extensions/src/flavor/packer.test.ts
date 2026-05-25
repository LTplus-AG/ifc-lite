/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { packFlavor, unpackFlavor } from './packer.js';
import type { Flavor } from './types.js';

function flavor(): Flavor {
  return {
    schemaVersion: 1,
    id: 'flv.pack',
    name: 'Pack Test',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    extensions: [],
    lenses: [],
    savedQueries: [],
    keybindings: [],
    layout: { state: {} },
    settings: { theme: 'dark' },
  };
}

describe('packFlavor / unpackFlavor', () => {
  it('round-trips a minimal flavor', () => {
    const bytes = packFlavor(flavor());
    const r = unpackFlavor(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.flavor.id).toBe('flv.pack');
      expect(r.value.extensionBundles.size).toBe(0);
    }
  });

  it('round-trips embedded extension bundles', () => {
    const bundles = new Map<string, Uint8Array>([
      ['com.example.a@1.0.0', new Uint8Array([1, 2, 3])],
      ['com.example.b@2.1.0', new Uint8Array([9, 8, 7, 6])],
    ]);
    const bytes = packFlavor(flavor(), { extensionBundles: bundles });
    const r = unpackFlavor(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.extensionBundles.size).toBe(2);
      expect(Array.from(r.value.extensionBundles.get('com.example.a@1.0.0') ?? [])).toEqual([1, 2, 3]);
    }
  });

  it('is deterministic for the same input', () => {
    const a = packFlavor(flavor());
    const b = packFlavor(flavor());
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  it('preserves summary', () => {
    const bytes = packFlavor(flavor(), { summary: '3 extensions, 2 lenses' });
    const r = unpackFlavor(bytes);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.summary).toBe('3 extensions, 2 lenses');
  });
});

describe('unpackFlavor — error cases', () => {
  it('rejects garbage bytes', () => {
    expect(unpackFlavor(new Uint8Array([1, 2, 3])).ok).toBe(false);
  });

  it('rejects wrong format string', () => {
    const env = gzipSync(new TextEncoder().encode(JSON.stringify({
      format: 'other',
      version: 1,
      flavor: flavor(),
      extensionBundles: {},
    })));
    expect(unpackFlavor(env).ok).toBe(false);
  });

  it('rejects unsupported version', () => {
    const env = gzipSync(new TextEncoder().encode(JSON.stringify({
      format: 'iflv',
      version: 99,
      flavor: flavor(),
      extensionBundles: {},
    })));
    expect(unpackFlavor(env).ok).toBe(false);
  });

  it('propagates flavor schema errors', () => {
    const env = gzipSync(new TextEncoder().encode(JSON.stringify({
      format: 'iflv',
      version: 1,
      flavor: { ...flavor(), id: 'BAD ID' },
      extensionBundles: {},
    })));
    expect(unpackFlavor(env).ok).toBe(false);
  });

  it('rejects malformed base64 in extensionBundles', () => {
    const env = gzipSync(new TextEncoder().encode(JSON.stringify({
      format: 'iflv',
      version: 1,
      flavor: flavor(),
      extensionBundles: { 'com.example.a@1.0.0': 'not-base64!@#' },
    })));
    expect(unpackFlavor(env).ok).toBe(false);
  });
});
