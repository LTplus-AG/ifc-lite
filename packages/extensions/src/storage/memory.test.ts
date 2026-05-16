/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { InMemoryExtensionStorage } from './memory.js';
import type { InstalledExtensionRecord } from './types.js';

function makeRecord(overrides: Partial<InstalledExtensionRecord> = {}): InstalledExtensionRecord {
  return {
    id: 'com.example.test',
    version: '1.0.0',
    bundleHash: 'deadbeef',
    grantedCapabilities: ['model.read'],
    enabled: true,
    installedAt: '2026-01-01T00:00:00.000Z',
    source: 'local',
    ...overrides,
  };
}

describe('InMemoryExtensionStorage — records', () => {
  it('round-trips a record', async () => {
    const store = new InMemoryExtensionStorage();
    await store.putExtension(makeRecord());
    const got = await store.getExtension('com.example.test');
    expect(got?.id).toBe('com.example.test');
    expect(got?.version).toBe('1.0.0');
  });

  it('returns undefined for missing record', async () => {
    const store = new InMemoryExtensionStorage();
    expect(await store.getExtension('missing')).toBeUndefined();
  });

  it('lists all records', async () => {
    const store = new InMemoryExtensionStorage();
    await store.putExtension(makeRecord({ id: 'a' }));
    await store.putExtension(makeRecord({ id: 'b' }));
    const records = await store.listExtensions();
    expect(records.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('delete removes the record', async () => {
    const store = new InMemoryExtensionStorage();
    await store.putExtension(makeRecord());
    await store.deleteExtension('com.example.test');
    expect(await store.getExtension('com.example.test')).toBeUndefined();
  });

  it('put then mutate the source does not affect stored copy', async () => {
    const store = new InMemoryExtensionStorage();
    const record = makeRecord();
    await store.putExtension(record);
    record.grantedCapabilities.push('viewer.read');
    const got = await store.getExtension(record.id);
    expect(got?.grantedCapabilities).toEqual(['model.read']);
  });
});

describe('InMemoryExtensionStorage — bundles', () => {
  it('round-trips a bundle', async () => {
    const store = new InMemoryExtensionStorage();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.putBundle('com.example.x', '1.0.0', bytes);
    const got = await store.getBundle('com.example.x', '1.0.0');
    expect(got).toBeDefined();
    expect(got?.length).toBe(4);
  });

  it('returns a defensive copy', async () => {
    const store = new InMemoryExtensionStorage();
    const bytes = new Uint8Array([1, 2, 3]);
    await store.putBundle('x', '1.0.0', bytes);
    bytes[0] = 99;
    const got = await store.getBundle('x', '1.0.0');
    expect(got?.[0]).toBe(1);
  });

  it('delete removes only the matching version', async () => {
    const store = new InMemoryExtensionStorage();
    await store.putBundle('x', '1.0.0', new Uint8Array([1]));
    await store.putBundle('x', '2.0.0', new Uint8Array([2]));
    await store.deleteBundle('x', '1.0.0');
    expect(await store.getBundle('x', '1.0.0')).toBeUndefined();
    expect(await store.getBundle('x', '2.0.0')).toBeDefined();
  });

  it('deleting an extension cascades to its bundles', async () => {
    const store = new InMemoryExtensionStorage();
    await store.putExtension(makeRecord({ id: 'cascade' }));
    await store.putBundle('cascade', '1.0.0', new Uint8Array([1]));
    await store.putBundle('cascade', '2.0.0', new Uint8Array([2]));
    await store.deleteExtension('cascade');
    expect(await store.getBundle('cascade', '1.0.0')).toBeUndefined();
    expect(await store.getBundle('cascade', '2.0.0')).toBeUndefined();
  });
});

describe('InMemoryExtensionStorage — clear', () => {
  it('removes all records and bundles', async () => {
    const store = new InMemoryExtensionStorage();
    await store.putExtension(makeRecord({ id: 'a' }));
    await store.putBundle('a', '1.0.0', new Uint8Array([1]));
    await store.clear();
    expect(await store.listExtensions()).toEqual([]);
    expect(await store.getBundle('a', '1.0.0')).toBeUndefined();
  });
});
