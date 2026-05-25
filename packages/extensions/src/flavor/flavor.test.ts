/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { diffFlavors } from './diff.js';
import { mergeFlavors } from './merge.js';
import { validateFlavor } from './schema.js';
import { InMemoryFlavorStorage } from './storage.js';
import type { Flavor, FlavorExtension } from './types.js';

function baseFlavor(overrides: Partial<Flavor> = {}): Flavor {
  return {
    schemaVersion: 1,
    id: 'flv.default',
    name: 'Default',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    extensions: [],
    lenses: [],
    savedQueries: [],
    keybindings: [],
    layout: { state: {} },
    settings: {},
    ...overrides,
  };
}

function ext(id: string, version = '1.0.0', caps: string[] = ['model.read']): FlavorExtension {
  return {
    id,
    version,
    bundleHash: 'a'.repeat(64),
    grantedCapabilities: caps,
    enabled: true,
    source: 'local',
  };
}

describe('validateFlavor', () => {
  it('accepts a minimal valid flavor', () => {
    const r = validateFlavor(baseFlavor());
    expect(r.ok).toBe(true);
  });

  it('rejects unknown schemaVersion', () => {
    const r = validateFlavor({ ...baseFlavor(), schemaVersion: 2 });
    expect(r.ok).toBe(false);
  });

  it('rejects bad id format', () => {
    const r = validateFlavor({ ...baseFlavor(), id: 'BAD ID' });
    expect(r.ok).toBe(false);
  });

  it('rejects missing extensions array', () => {
    const r = validateFlavor({ ...baseFlavor(), extensions: undefined });
    expect(r.ok).toBe(false);
  });

  it('flags malformed bundleHash', () => {
    const r = validateFlavor({
      ...baseFlavor(),
      extensions: [{ ...ext('com.example.a'), bundleHash: 'short' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects bad source value', () => {
    const r = validateFlavor({
      ...baseFlavor(),
      extensions: [{ ...ext('com.example.a'), source: 'unknown' as never }],
    });
    expect(r.ok).toBe(false);
  });
});

describe('diffFlavors', () => {
  it('reports added extension', () => {
    const theirs = baseFlavor();
    const ours = baseFlavor({ extensions: [ext('com.example.new')] });
    const d = diffFlavors(theirs, ours);
    expect(d.extensions.added).toHaveLength(1);
    expect(d.extensions.added[0].id).toBe('com.example.new');
  });

  it('reports removed extension', () => {
    const theirs = baseFlavor({ extensions: [ext('com.example.a')] });
    const ours = baseFlavor();
    const d = diffFlavors(theirs, ours);
    expect(d.extensions.removed.map((e) => e.id)).toEqual(['com.example.a']);
  });

  it('reports version change', () => {
    const theirs = baseFlavor({ extensions: [ext('com.example.a', '1.0.0')] });
    const ours = baseFlavor({ extensions: [ext('com.example.a', '2.0.0')] });
    const d = diffFlavors(theirs, ours);
    expect(d.extensions.versionChanged).toHaveLength(1);
    expect(d.extensions.versionChanged[0]).toMatchObject({ id: 'com.example.a', from: '1.0.0', to: '2.0.0' });
  });

  it('reports capability change at the same version', () => {
    const theirs = baseFlavor({ extensions: [ext('com.example.a', '1.0.0', ['model.read'])] });
    const ours = baseFlavor({ extensions: [ext('com.example.a', '1.0.0', ['model.read', 'viewer.read'])] });
    const d = diffFlavors(theirs, ours);
    expect(d.extensions.capabilityChanged).toHaveLength(1);
    expect(d.extensions.capabilityChanged[0].added).toEqual(['viewer.read']);
  });

  it('reports settings changes per-key', () => {
    const theirs = baseFlavor({ settings: { a: 1, b: 2 } });
    const ours = baseFlavor({ settings: { a: 99, c: 3 } });
    const d = diffFlavors(theirs, ours);
    expect(Object.keys(d.settings.added)).toEqual(['c']);
    expect(d.settings.removed).toEqual(['b']);
    expect(d.settings.changed).toHaveLength(1);
    expect(d.settings.changed[0]).toMatchObject({ key: 'a', ours: 99, theirs: 1 });
  });

  it('reports prompt overlay change', () => {
    const theirs = baseFlavor({ promptOverlay: { content: 'old', updatedAt: 'x' } });
    const ours = baseFlavor({ promptOverlay: { content: 'new', updatedAt: 'y' } });
    const d = diffFlavors(theirs, ours);
    expect(d.promptOverlay.changed).toBe(true);
  });
});

describe('mergeFlavors — three-way', () => {
  it('takes higher semver when versions differ at the same id', () => {
    const base = baseFlavor({ extensions: [ext('com.example.a', '1.0.0')] });
    const theirs = baseFlavor({ extensions: [ext('com.example.a', '2.0.0')] });
    const ours = baseFlavor({ extensions: [ext('com.example.a', '1.0.0')] });
    const { merged, conflicts } = mergeFlavors(base, theirs, ours);
    expect(merged.extensions[0].version).toBe('2.0.0');
    expect(conflicts.some((c) => c.kind === 'extension_version')).toBe(true);
  });

  it('intersects granted capabilities (more restrictive wins)', () => {
    const base = baseFlavor();
    const theirs = baseFlavor({ extensions: [ext('com.example.a', '1.0.0', ['model.read', 'viewer.read', 'export.create:csv'])] });
    const ours = baseFlavor({ extensions: [ext('com.example.a', '1.0.0', ['model.read', 'viewer.read'])] });
    const { merged } = mergeFlavors(base, theirs, ours);
    expect(merged.extensions[0].grantedCapabilities).toEqual(['model.read', 'viewer.read']);
  });

  it('unions added extensions from both sides', () => {
    const base = baseFlavor();
    const theirs = baseFlavor({ extensions: [ext('com.example.t')] });
    const ours = baseFlavor({ extensions: [ext('com.example.o')] });
    const { merged } = mergeFlavors(base, theirs, ours);
    expect(merged.extensions.map((e) => e.id).sort()).toEqual(['com.example.o', 'com.example.t']);
  });

  it('takes theirs for settings unchanged from base', () => {
    const base = baseFlavor({ settings: { theme: 'dark' } });
    const theirs = baseFlavor({ settings: { theme: 'light' } });
    const ours = baseFlavor({ settings: { theme: 'dark' } });
    const { merged } = mergeFlavors(base, theirs, ours);
    expect(merged.settings.theme).toBe('light');
  });

  it('appends prompt overlays when both sides have content', () => {
    const base = baseFlavor();
    const theirs = baseFlavor({ promptOverlay: { content: 'imported text', updatedAt: '2026' } });
    const ours = baseFlavor({ promptOverlay: { content: 'my text', updatedAt: '2026' } });
    const { merged } = mergeFlavors(base, theirs, ours);
    expect(merged.promptOverlay?.content).toContain('my text');
    expect(merged.promptOverlay?.content).toContain('imported text');
  });
});

describe('InMemoryFlavorStorage', () => {
  it('round-trips a flavor', async () => {
    const store = new InMemoryFlavorStorage();
    await store.putFlavor(baseFlavor({ id: 'flv.a' }));
    const got = await store.getFlavor('flv.a');
    expect(got?.id).toBe('flv.a');
  });

  it('lists flavors', async () => {
    const store = new InMemoryFlavorStorage();
    await store.putFlavor(baseFlavor({ id: 'flv.a' }));
    await store.putFlavor(baseFlavor({ id: 'flv.b' }));
    expect((await store.listFlavors()).map((f) => f.id).sort()).toEqual(['flv.a', 'flv.b']);
  });

  it('snapshots on write and respects the cap', async () => {
    const store = new InMemoryFlavorStorage({ snapshotCap: 2 });
    for (let i = 0; i < 5; i += 1) {
      await store.putFlavor(baseFlavor({ id: 'flv.s', updatedAt: `2026-01-0${i + 1}T00:00:00.000Z` }));
    }
    const snaps = await store.listSnapshots('flv.s');
    expect(snaps.length).toBe(2);
  });

  it('restoreSnapshot rolls back', async () => {
    const store = new InMemoryFlavorStorage();
    await store.putFlavor(baseFlavor({ id: 'flv.r', name: 'v1' }));
    await store.putFlavor(baseFlavor({ id: 'flv.r', name: 'v2' }));
    const snaps = await store.listSnapshots('flv.r');
    expect(snaps).toHaveLength(1);
    const restored = await store.restoreSnapshot('flv.r', snaps[0].seq);
    expect(restored?.name).toBe('v1');
  });

  it('active-flavor pointer guards against unknown ids', async () => {
    const store = new InMemoryFlavorStorage();
    await expect(store.setActiveId('does-not-exist')).rejects.toThrow();
  });

  it('cascades delete to snapshots + active pointer', async () => {
    const store = new InMemoryFlavorStorage();
    await store.putFlavor(baseFlavor({ id: 'flv.del' }));
    await store.setActiveId('flv.del');
    await store.deleteFlavor('flv.del');
    expect(await store.getActiveId()).toBeUndefined();
    expect(await store.listSnapshots('flv.del')).toEqual([]);
  });
});
