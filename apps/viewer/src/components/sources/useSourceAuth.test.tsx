/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wiring coverage for catalog-cache identity scoping (#1976 review thread on
 * `useSourceCatalogSync.ts:172`).
 *
 * `persistence.test.ts` pins `syncSourceCatalogCacheOwner` itself. This file
 * pins that the HOOK actually calls it, which is a separate property and the
 * load-bearing one: the unit can be perfectly correct while nothing invokes
 * it, and every existing test would still pass. Before this file,
 * `useSourceAuth` had no tests at all, so deleting the calls from `restore()`
 * or `signIn()` was invisible.
 *
 * The path that matters is `restore()`, not `signOut()`. Sign-out already
 * cleared the cache, but the cache lives in `localStorage` and outlives the
 * tab while the owning identity lived only in React state — so the leak is
 * the user who never signs out: closes the tab or lets the session expire,
 * and the next identity on that browser profile gets a cache hit on folder
 * and file names that were never theirs to see.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  FileSourceProvider,
  Page,
  PluginContext,
  PluginManifest,
  SourceContainer,
  SourceFile,
  SourceIdentity,
  SourceProject,
} from '@ifc-lite/plugin-api';
import type { SourceHost } from '@/services/sources/source-host';
import { loadSourceCatalogCache, saveSourceCatalogCache, syncSourceCatalogCacheOwner } from '@/lib/sources/persistence';
import { useSourceAuth } from './useSourceAuth.js';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}

const localStorageMock = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageMock });

const ctx: PluginContext = {
  fetch: (() => Promise.reject(new Error('not exercised'))) as typeof fetch,
  fetchPublic: () => Promise.reject(new Error('not exercised')),
  getPreference: () => Promise.resolve(undefined),
  storage: {
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
  },
  log: { debug() {}, info() {}, warn() {}, error() {} },
};

const PROVIDER_ID = 'fixture-auth-provider';

const manifest: PluginManifest = {
  name: PROVIDER_ID,
  title: 'Fixture Auth Provider',
  api: '^2.0.0',
  permissions: { network: ['fixture.example.com'] },
  auth: 'interactive',
  preferences: [],
  capabilities: {
    containerListing: 'flat-subtree',
    listFilesIsRecursive: true,
    revisionHistory: false,
    downloadHistoricalRevisions: false,
    changeDetection: false,
    search: false,
  },
  contributes: { fileSources: [] },
};

const ALICE: SourceIdentity = { id: 'alice@example.com', displayName: 'Alice' };
const BOB: SourceIdentity = { id: 'bob@example.com', displayName: 'Bob' };

/** Provider whose auth outcomes are set per test. */
class AuthProvider implements FileSourceProvider {
  readonly manifest = manifest;
  restoreResult: SourceIdentity | null | Error = null;
  signInResult: SourceIdentity | Error = ALICE;

  readonly auth = {
    restore: (): Promise<SourceIdentity | null> =>
      this.restoreResult instanceof Error
        ? Promise.reject(this.restoreResult)
        : Promise.resolve(this.restoreResult),
    signIn: (): Promise<SourceIdentity> =>
      this.signInResult instanceof Error
        ? Promise.reject(this.signInResult)
        : Promise.resolve(this.signInResult),
    signOut: (): Promise<void> => Promise.resolve(),
    getIdentity: (): Promise<SourceIdentity | null> => Promise.resolve(null),
  };

  async listProjects(): Promise<Page<SourceProject>> { return { items: [] }; }
  async listContainers(): Promise<Page<SourceContainer>> { return { items: [] }; }
  async listFiles(): Promise<Page<SourceFile>> { return { items: [] }; }
  download(): Promise<ArrayBuffer> { return Promise.reject(new Error('not exercised')); }
}

const sourceHost = { createContext: () => ctx } as unknown as SourceHost;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderAuth(provider: FileSourceProvider): { get: () => ReturnType<typeof useSourceAuth> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest: ReturnType<typeof useSourceAuth> | null = null;

  function Probe() {
    latest = useSourceAuth(provider, sourceHost);
    return null;
  }

  act(() => {
    root.render(<Probe />);
  });
  mounted.push({ root, container });

  return {
    get: () => {
      if (!latest) throw new Error('hook has not rendered yet');
      return latest;
    },
  };
}

/** Seed a catalog cache owned by `identity`, exactly as a real session would. */
function seedCatalogOwnedBy(identity: SourceIdentity): void {
  syncSourceCatalogCacheOwner(PROVIDER_ID, identity.id);
  saveSourceCatalogCache(
    PROVIDER_ID,
    'project-1',
    'area-1',
    [{ id: 'folder-1', name: "Alice's confidential project", parentId: 'area-1' }],
    [],
  );
}

const cachedCatalog = () => loadSourceCatalogCache(PROVIDER_ID, 'project-1', 'area-1');

describe('useSourceAuth -- catalog cache is scoped to the signed-in identity (#1976)', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      // Unmount in its own act() per root: batching every unmount into one
      // act() lets a teardown error in the first root swallow the rest.
      act(() => { root.unmount(); });
      container.remove();
    }
    localStorageMock.clear();
  });

  it('drops a cache owned by another identity when restore() brings back a new session', async () => {
    seedCatalogOwnedBy(ALICE);
    assert.ok(cachedCatalog(), 'precondition: alice-owned catalog is cached');

    const provider = new AuthProvider();
    provider.restoreResult = BOB;

    const harness = renderAuth(provider);
    await act(async () => { await Promise.resolve(); });

    assert.equal(harness.get().identity?.id, BOB.id);
    assert.equal(cachedCatalog(), null, "bob must never see alice's cached folder names");
  });

  it('keeps the cache when restore() brings back the SAME identity', async () => {
    seedCatalogOwnedBy(ALICE);

    const provider = new AuthProvider();
    provider.restoreResult = ALICE;

    const harness = renderAuth(provider);
    await act(async () => { await Promise.resolve(); });

    assert.equal(harness.get().identity?.id, ALICE.id);
    assert.ok(cachedCatalog(), 'alice returning must not pay for a needless refetch');
  });

  it('drops the cache when restore() resolves no session', async () => {
    seedCatalogOwnedBy(ALICE);

    const provider = new AuthProvider();
    provider.restoreResult = null;

    renderAuth(provider);
    await act(async () => { await Promise.resolve(); });

    assert.equal(cachedCatalog(), null);
  });

  it('drops the cache when the silent restore FAILS (expired session)', async () => {
    seedCatalogOwnedBy(ALICE);

    const provider = new AuthProvider();
    provider.restoreResult = new Error('session expired');

    const harness = renderAuth(provider);
    await act(async () => { await Promise.resolve(); });

    assert.equal(harness.get().status, 'signed-out');
    assert.equal(cachedCatalog(), null, 'an expired session must not leave a readable catalog behind');
  });

  it('drops a cache owned by another identity on interactive sign-in', async () => {
    const provider = new AuthProvider();
    provider.restoreResult = null;
    provider.signInResult = BOB;

    const harness = renderAuth(provider);
    await act(async () => { await Promise.resolve(); });

    // Alice's catalog lands after the restore settled -- i.e. the cache is
    // present at the moment bob signs in, which is the case that leaks.
    seedCatalogOwnedBy(ALICE);
    assert.ok(cachedCatalog());

    await act(async () => {
      harness.get().signIn();
      await Promise.resolve();
    });

    assert.equal(harness.get().identity?.id, BOB.id);
    assert.equal(cachedCatalog(), null);
  });
});
