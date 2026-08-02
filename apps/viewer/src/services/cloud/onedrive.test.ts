/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Covers the followedSites degradation path (issue: a personal/consumer
 * Microsoft account has no SharePoint sites at all, and must not be
 * treated as an error). No live Graph credentials are used — every network
 * call is stubbed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OneDriveProvider } from './onedrive.js';

/** Minimal Storage surface the provider actually calls. */
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown; fetch?: typeof fetch };
const originalLocalStorage = g.localStorage;
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalError = console.error;
const originalDebug = console.debug;

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
}

describe('OneDriveProvider — followedSites degradation', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
    // Silence expected log noise from the paths under test; assertions below
    // check status-driven behavior, not console output.
    console.warn = () => {};
    console.error = () => {};
    console.debug = () => {};
  });

  afterEach(() => {
    // Restore every global this suite stubs — leaving the test-local
    // MemoryStorage installed as `globalThis.localStorage` would leak into
    // any other test file that runs in this same process afterward.
    g.localStorage = originalLocalStorage;
    g.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
    console.debug = originalDebug;
  });

  it('degrades to a "needs a work or school account" row on a 400 (consumer account)', async () => {
    g.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/onedrive/token')) return tokenResponse();
      if (u.includes('followedSites')) return new Response('bad request', { status: 400 });
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;

    const provider = new OneDriveProvider();
    const entries = await provider.listFolder('');

    assert.deepStrictEqual(
      entries.map((e) => e.id),
      ['me-root', 'sites-unavailable'],
    );
    const notice = entries.find((e) => e.id === 'sites-unavailable');
    assert.ok(notice?.disabled, 'the notice row must be inert (disabled)');
    assert.match(notice!.name, /work or school account/);
  });

  it('degrades the same way on a 404 (consumer account)', async () => {
    g.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/onedrive/token')) return tokenResponse();
      if (u.includes('followedSites')) return new Response('not found', { status: 404 });
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;

    const provider = new OneDriveProvider();
    const entries = await provider.listFolder('');
    const notice = entries.find((e) => e.id === 'sites-unavailable');
    assert.ok(notice?.disabled);
    assert.match(notice!.name, /work or school account/);
  });

  it('reports a genuine failure (5xx) distinctly from the consumer-account case', async () => {
    g.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/onedrive/token')) return tokenResponse();
      if (u.includes('followedSites')) return new Response('boom', { status: 500 });
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;

    const provider = new OneDriveProvider();
    const entries = await provider.listFolder('');
    const notice = entries.find((e) => e.id === 'sites-unavailable');
    assert.ok(notice?.disabled);
    // Positive assertion: a wrong-or-empty message would pass a bare
    // doesNotMatch(/work or school account/) check, so pin the actual text.
    assert.equal(notice!.name, "Couldn't check SharePoint sites — try again later");
  });

  it('lists followed sites normally when the call succeeds (work/school account)', async () => {
    g.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/onedrive/token')) return tokenResponse();
      if (u.includes('followedSites')) {
        return new Response(JSON.stringify({ value: [{ id: 'site-1', displayName: 'Engineering' }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;

    const provider = new OneDriveProvider();
    const entries = await provider.listFolder('');

    assert.deepStrictEqual(
      entries.map((e) => e.id),
      ['me-root', 'site:site-1'],
    );
    assert.ok(!entries.some((e) => e.disabled));
  });
});

describe('OneDriveProvider#download — malformed path guard', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
    console.warn = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    g.localStorage = originalLocalStorage;
    g.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
  });

  it('rejects a "site:" path instead of silently parsing a wrong driveId/itemId', async () => {
    g.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/onedrive/token')) return tokenResponse();
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;

    const provider = new OneDriveProvider();
    await assert.rejects(
      provider.download({ id: 'x', name: 'x.ifc', path: 'site:not-a-drive-ref', size: 0, isFolder: false, modifiedMs: null }),
      /expected a "dl:" ref/,
    );
  });
});
