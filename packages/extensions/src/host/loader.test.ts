/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packBundle } from '../bundle/iflx.js';
import { loadBundleFromDirectory } from '../bundle/loader.js';
import { SlotRegistry } from '../slot-registry.js';
import { InMemoryExtensionStorage } from '../storage/memory.js';
import { sha256Hex } from '../storage/hash.js';
import type { InstalledExtensionRecord } from '../storage/types.js';
import { ActivationDispatcher } from './activation.js';
import { ExtensionLoader, manifestToContributions } from './loader.js';
import type { ManifestContributions } from '../types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const GOOD_BUNDLE = join(__dirname, '..', '..', 'test', 'fixtures', 'bundles', 'good');

async function installGood(): Promise<{
  storage: InMemoryExtensionStorage;
  registry: SlotRegistry;
  dispatcher: ActivationDispatcher;
  loader: ExtensionLoader;
  record: InstalledExtensionRecord;
  bytes: Uint8Array;
}> {
  const bundleResult = await loadBundleFromDirectory(GOOD_BUNDLE);
  if (!bundleResult.ok) throw new Error('fixture failed to load');
  const bytes = packBundle(bundleResult.value);
  const hash = await sha256Hex(bytes);

  const storage = new InMemoryExtensionStorage();
  const registry = new SlotRegistry();
  const dispatcher = new ActivationDispatcher();
  const loader = new ExtensionLoader({ storage, registry, dispatcher });
  const record: InstalledExtensionRecord = {
    id: bundleResult.value.manifest.id,
    version: bundleResult.value.manifest.version,
    bundleHash: hash,
    grantedCapabilities: bundleResult.value.manifest.capabilities,
    enabled: true,
    installedAt: new Date('2026-01-01').toISOString(),
    source: 'local',
  };
  await storage.putExtension(record);
  await storage.putBundle(record.id, record.version, bytes);

  return { storage, registry, dispatcher, loader, record, bytes };
}

describe('manifestToContributions', () => {
  it('returns empty list when contributes is undefined', () => {
    expect(manifestToContributions('ext-a', undefined)).toEqual([]);
  });

  it('translates commands to commandPalette slot', () => {
    const out = manifestToContributions('ext-a', {
      commands: [{ id: 'ext-a.cmd', title: 'Cmd' }],
    } as ManifestContributions);
    expect(out).toHaveLength(1);
    expect(out[0].slot).toBe('commandPalette');
  });

  it('translates toolbar items into their declared slots', () => {
    const out = manifestToContributions('ext-a', {
      toolbar: [{ command: 'ext-a.cmd', slot: 'toolbar.right' }],
    } as ManifestContributions);
    expect(out[0].slot).toBe('toolbar.right');
  });

  it('keeps extension ids consistent', () => {
    const out = manifestToContributions('ext-a', {
      commands: [{ id: 'x', title: 'X' }],
    } as ManifestContributions);
    expect(out.every((c) => c.extensionId === 'ext-a')).toBe(true);
  });
});

describe('ExtensionLoader — happy path', () => {
  it('loads a good bundle end-to-end', async () => {
    const { loader } = await installGood();
    const statuses = await loader.loadAll();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].ok).toBe(true);
    expect(statuses[0].grantedCapabilities?.map((c) => c.raw)).toEqual([
      'model.read',
      'viewer.read',
    ]);
  });

  it('registers manifest contributions in the slot registry', async () => {
    const { loader, registry, record } = await installGood();
    await loader.loadAll();
    const toolbar = registry.getAll('toolbar.right');
    expect(toolbar).toHaveLength(1);
    expect(toolbar[0].extensionId).toBe(record.id);
  });

  it('registers activation events with the dispatcher', async () => {
    const { loader, dispatcher } = await installGood();
    await loader.loadAll();
    expect(dispatcher.listEvents()).toContain('onCommand:ext.example.good.run');
  });

  it('caches the parsed bundle for repeated access', async () => {
    const { loader, record } = await installGood();
    await loader.loadAll();
    const bundle = loader.getBundle(record.id);
    expect(bundle?.manifest.id).toBe(record.id);
  });

  it('unload removes contributions and activation events', async () => {
    const { loader, registry, dispatcher, record } = await installGood();
    await loader.loadAll();
    await loader.unload(record.id);
    expect(registry.hasExtension(record.id)).toBe(false);
    expect(dispatcher.listExtensions()).toEqual([]);
    expect(loader.getBundle(record.id)).toBeUndefined();
  });
});

describe('ExtensionLoader — error paths', () => {
  it('reports missing bundle bytes', async () => {
    const { loader, storage, record } = await installGood();
    await storage.deleteBundle(record.id, record.version);
    const [status] = await loader.loadAll();
    expect(status.ok).toBe(false);
    expect(status.errors[0].code).toBe('invalid_reference');
  });

  it('detects bundle hash tamper', async () => {
    const { loader, storage, record } = await installGood();
    // Corrupt the stored bytes.
    await storage.putBundle(record.id, record.version, new Uint8Array([1, 2, 3, 4]));
    const [status] = await loader.loadAll();
    expect(status.ok).toBe(false);
    expect(status.errors[0].message).toContain('hash mismatch');
  });

  it('skips a disabled extension', async () => {
    const { loader, storage, record } = await installGood();
    await storage.putExtension({ ...record, enabled: false });
    const [status] = await loader.loadAll();
    expect(status.ok).toBe(false);
    expect(status.errors[0].message).toContain('disabled');
  });

  it('rejects mismatched manifest id vs record id', async () => {
    const { loader, storage, record, bytes } = await installGood();
    // Install a second record whose id does not match the bundle's manifest.id,
    // but whose bytes (and therefore hash) are the same.
    const wrongRecord = { ...record, id: 'com.example.different' };
    await storage.putExtension(wrongRecord);
    await storage.putBundle(wrongRecord.id, wrongRecord.version, bytes);
    const result = await loader.load('com.example.different');
    expect(result?.ok).toBe(false);
    expect(result?.errors[0].path).toBe('manifest.id');
  });

  it('one bad extension does not block others', async () => {
    const { loader, storage, record } = await installGood();
    await storage.putExtension({
      ...record,
      id: 'com.example.broken',
      bundleHash: 'wrong',
    });
    const statuses = await loader.loadAll();
    expect(statuses).toHaveLength(2);
    expect(statuses.find((s) => s.id === record.id)?.ok).toBe(true);
    expect(statuses.find((s) => s.id === 'com.example.broken')?.ok).toBe(false);
  });
});

describe('ExtensionLoader — load(id)', () => {
  it('returns undefined for unknown id', async () => {
    const { loader } = await installGood();
    expect(await loader.load('not.installed')).toBeUndefined();
  });
});
