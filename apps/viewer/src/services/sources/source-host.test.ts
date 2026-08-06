/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLUGIN_API_VERSION,
  satisfiesCaretRange,
  type FileSourceProvider,
  type PluginManifest,
  type PluginPermissions,
} from '@ifc-lite/plugin-api';
import { SourceHost } from './source-host';
import { MAX_FETCH_ATTEMPTS } from './host-fetch';
import { createRegisteredProviders } from './registered-providers';

// ----------------------------------------------------------------------------
// Test doubles for the browser globals this module touches. Following the
// same-file convention already used elsewhere in the viewer's node:test suite
// (e.g. `store/slices/uiSlice.toolbar-style.test.ts`): define the global
// before the code under test runs, restore nothing afterward since each
// `describe` here only cares about its own calls.
// ----------------------------------------------------------------------------

function installWindow(origin: string): void {
  Object.defineProperty(globalThis, 'window', {
    value: { location: { origin }, dispatchEvent: () => true },
    configurable: true,
    writable: true,
  });
}

installWindow('https://viewer.example.com');

// ----------------------------------------------------------------------------
// Manifest / provider builders
// ----------------------------------------------------------------------------

function makeManifest(
  permissions: PluginPermissions,
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    name: 'test-provider',
    title: 'Test Provider',
    api: PLUGIN_API_VERSION,
    auth: 'preferences',
    permissions,
    preferences: [],
    capabilities: {
      containerListing: 'direct-children',
      listFilesIsRecursive: false,
      revisionHistory: false,
      downloadHistoricalRevisions: false,
      changeDetection: false,
      search: false,
    },
    contributes: { fileSources: ['./src/provider.ts'] },
    ...overrides,
  };
}

function makeProvider(
  permissions: PluginPermissions,
  overrides: Partial<PluginManifest> = {},
): FileSourceProvider {
  return {
    manifest: makeManifest(permissions, overrides),
    listProjects: async () => ({ items: [] }),
    listContainers: async () => ({ items: [] }),
    listFiles: async () => ({ items: [] }),
    download: async () => new ArrayBuffer(0),
  };
}

/** Swaps `globalThis.fetch` for the duration of `run`, always restoring it, even on throw. */
async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// ============================================================================
// Version pinning
// ============================================================================

describe('SourceHost.register — version pinning', () => {
  it('registers a provider whose manifest.api satisfies PLUGIN_API_VERSION', () => {
    const host = new SourceHost();
    const ok = host.register(makeProvider({ network: ['api.example.com'] }));
    assert.equal(ok, true);
    assert.equal(host.getRegistrationFailures().length, 0);
    assert.ok(host.get('test-provider'));
  });

  it('fails cleanly, WITHOUT throwing out of the host, when manifest.api does not satisfy PLUGIN_API_VERSION', () => {
    const host = new SourceHost();
    let ok: boolean | undefined;
    assert.doesNotThrow(() => {
      ok = host.register(makeProvider({ network: ['api.example.com'] }, { api: '^0.1.0' }));
    });
    assert.equal(ok, false);
    assert.equal(host.get('test-provider'), undefined);
    const failures = host.getRegistrationFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].provider, 'test-provider');
    assert.match(failures[0].reason, /\^0\.1\.0/);
  });

  it('registering the same provider name twice fails the second time without throwing', () => {
    const host = new SourceHost();
    assert.equal(host.register(makeProvider({ network: ['api.example.com'] })), true);
    let secondOk: boolean | undefined;
    assert.doesNotThrow(() => {
      secondOk = host.register(makeProvider({ network: ['api.example.com'] }));
    });
    assert.equal(secondOk, false);
  });
});

describe('every provider the viewer actually registers satisfies PLUGIN_API_VERSION', () => {
  // Regression guard for the bug that shipped: a host constant drifted from a
  // provider's declared `manifest.api` and the app white-screened instead of
  // failing loudly in CI. `createRegisteredProviders()` is the same list
  // `SourceHostProvider` registers at app start — not a hand-maintained
  // duplicate — so this can't drift from what actually ships.
  it('registers cleanly against the real host', () => {
    const providers = createRegisteredProviders();

    // Restored from the deliberate `=== 0` assertion the contract-only PR
    // carried: with no providers registered the per-provider loop below is
    // vacuous, so that PR inverted this to fail the moment one was added —
    // which is what brought it back here. This is the real anti-vacuity guard.
    assert.ok(providers.length > 0, 'expected at least one real provider to be registered');

    const host = new SourceHost();
    for (const provider of providers) {
      const ok = host.register(provider);
      assert.equal(
        ok,
        true,
        `provider "${provider.manifest.name}" (api "${provider.manifest.api}") failed to register: ` +
        `${host.getRegistrationFailures().find((f) => f.provider === provider.manifest.name)?.reason}`,
      );
      assert.ok(
        satisfiesCaretRange(PLUGIN_API_VERSION, provider.manifest.api),
        `provider "${provider.manifest.name}" declares api "${provider.manifest.api}", which host version "${PLUGIN_API_VERSION}" does not satisfy`,
      );
    }
    assert.equal(host.getRegistrationFailures().length, 0);
  });
});

// ============================================================================
// Relay validation at register()
// ============================================================================

describe('SourceHost.register — relay validation', () => {
  it('registers a provider declaring a configured relay route', () => {
    const host = new SourceHost();
    const ok = host.register(
      makeProvider({
        network: ['*.dalux.com'],
        relay: { upstream: 'https://node1.field.dalux.com/service/api', path: '/api/dalux' },
      }),
    );
    assert.equal(ok, true);
  });

  it('fails cleanly, without throwing, when a provider declares a relay the host has not configured', () => {
    const host = new SourceHost();
    let ok: boolean | undefined;
    assert.doesNotThrow(() => {
      ok = host.register(
        makeProvider({
          network: ['api.evil.com'],
          relay: { upstream: 'https://api.evil.com/v1', path: '/api/evil' },
        }),
      );
    });
    assert.equal(ok, false);
    assert.match(host.getRegistrationFailures()[0].reason, /does not match a route this host actually has configured/);
  });

  it('fails when the path is configured but the declared upstream does not match it', () => {
    const host = new SourceHost();
    const ok = host.register(
      makeProvider({
        network: ['*.dalux.com'],
        relay: { upstream: 'https://impostor.example.com/api', path: '/api/dalux' },
      }),
    );
    assert.equal(ok, false);
  });
});

// ============================================================================
// ctx.fetch — host allowlist enforcement
// ============================================================================

describe('ctx.fetch — allowlist bypass attempts all fail', () => {
  const manifest = makeManifest({ network: ['*.dalux.com'] });
  const ctx = new SourceHost().createContext(manifest, {});

  const bypassAttempts: ReadonlyArray<[string, string]> = [
    ['userinfo trick (hostname is actually evil.com)', 'https://dalux.com@evil.com/steal'],
    ['subdomain-suffix trick vs *.dalux.com', 'https://evildalux.com/steal'],
    ['protocol-relative URL', '//evil.com/steal'],
    ['data: scheme (no host)', 'data:text/plain,hello'],
    ['blob: scheme (no host)', 'blob:https://dalux.com/uuid'],
    ['http:// when https is expected', 'http://dalux.com/insecure'],
  ];

  for (const [label, url] of bypassAttempts) {
    it(`rejects: ${label}`, async () => {
      await assert.rejects(() => ctx.fetch(url));
    });
  }

  it('still allows the real, correctly-schemed upstream host', async () => {
    await withFetch(
      async () => new Response('ok'),
      async () => {
        const res = await ctx.fetch('https://node1.field.dalux.com/x');
        assert.equal(await res.text(), 'ok');
      },
    );
  });
});

// ============================================================================
// ctx.fetch — credentials, redirect, and Request-object input
// ============================================================================

describe('ctx.fetch — credentials and redirect are never negotiable', () => {
  it('always sends credentials "omit" and redirect "error", even if the caller asks otherwise', async () => {
    const manifest = makeManifest({ network: ['api.example.com'] });
    const ctx = new SourceHost().createContext(manifest, {});
    let capturedInit: RequestInit | undefined;

    await withFetch(
      async (_input, init) => {
        capturedInit = init;
        return new Response('ok');
      },
      async () => {
        await ctx.fetch('https://api.example.com/data', { credentials: 'include' });
      },
    );

    assert.equal(capturedInit?.credentials, 'omit');
    assert.equal(capturedInit?.redirect, 'error');
  });

  it('preserves a Request object\'s method, headers and body, while still forcing credentials/redirect', async () => {
    const manifest = makeManifest({ network: ['api.example.com'] });
    const ctx = new SourceHost().createContext(manifest, {});
    const request = new Request('https://api.example.com/data', {
      method: 'POST',
      headers: { 'X-Custom': 'yes' },
      body: 'hello',
      credentials: 'include',
    });

    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    await withFetch(
      async (input, init) => {
        capturedUrl = typeof input === 'string' ? input : input.toString();
        capturedInit = init;
        return new Response('ok');
      },
      async () => {
        await ctx.fetch(request);
      },
    );

    assert.equal(capturedUrl, 'https://api.example.com/data');
    assert.equal(capturedInit?.method, 'POST');
    assert.equal(new Headers(capturedInit?.headers).get('X-Custom'), 'yes');
    assert.equal(capturedInit?.credentials, 'omit');
    assert.equal(capturedInit?.redirect, 'error');
    const decoded = new TextDecoder().decode(capturedInit?.body as ArrayBuffer);
    assert.equal(decoded, 'hello');
  });
});

// ============================================================================
// ctx.fetch — bounded 429/503 retry
// ============================================================================

describe('ctx.fetch — bounded retry on 429/503 with Retry-After', () => {
  it('retries a 429 with Retry-After, then gives up once the attempt bound is hit', async () => {
    const manifest = makeManifest({ network: ['api.example.com'] });
    const ctx = new SourceHost().createContext(manifest, {});
    let calls = 0;

    const response = await withFetch(
      async () => {
        calls++;
        return new Response(null, { status: 429, headers: { 'Retry-After': '0.01' } });
      },
      () => ctx.fetch('https://api.example.com/data'),
    );

    assert.equal(response.status, 429);
    assert.equal(calls, MAX_FETCH_ATTEMPTS);
  });

  it('does NOT replay a POST on 429 — only idempotent methods are retried', async () => {
    // A 429/503 means "throttled", not "had no effect". An upstream that
    // accepted the POST and then shed load would receive the body twice and
    // double-create whatever it described, so a non-idempotent request gets
    // exactly one attempt and the throttled response goes back to the provider.
    const manifest = makeManifest({ network: ['api.example.com'] });
    const ctx = new SourceHost().createContext(manifest, {});
    let calls = 0;

    const response = await withFetch(
      async () => {
        calls++;
        return new Response(null, { status: 429, headers: { 'Retry-After': '0.01' } });
      },
      () => ctx.fetch('https://api.example.com/data', { method: 'POST', body: '{"create":1}' }),
    );

    assert.equal(response.status, 429);
    assert.equal(calls, 1, 'a POST must be sent exactly once, never replayed');
  });

  it('stops retrying as soon as a non-429/503 response arrives', async () => {
    const manifest = makeManifest({ network: ['api.example.com'] });
    const ctx = new SourceHost().createContext(manifest, {});
    let calls = 0;

    const response = await withFetch(
      async () => {
        calls++;
        return calls === 1
          ? new Response(null, { status: 503, headers: { 'Retry-After': '0.01' } })
          : new Response('ok', { status: 200 });
      },
      () => ctx.fetch('https://api.example.com/data'),
    );

    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  });

  it('does not retry a 429 that carries no Retry-After', async () => {
    const manifest = makeManifest({ network: ['api.example.com'] });
    const ctx = new SourceHost().createContext(manifest, {});
    let calls = 0;

    const response = await withFetch(
      async () => {
        calls++;
        return new Response(null, { status: 429 });
      },
      () => ctx.fetch('https://api.example.com/data'),
    );

    assert.equal(response.status, 429);
    assert.equal(calls, 1);
  });

  it('respects an AbortSignal firing mid-wait', async () => {
    const manifest = makeManifest({ network: ['api.example.com'] });
    const ctx = new SourceHost().createContext(manifest, {});
    const controller = new AbortController();

    const pending = withFetch(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '5' } }),
      () => ctx.fetch('https://api.example.com/data', { signal: controller.signal }),
    );
    controller.abort();

    await assert.rejects(() => pending);
  });
});

// ============================================================================
// ctx.fetchPublic
// ============================================================================

describe('ctx.fetchPublic', () => {
  it('enforces permissions.publicNetwork, independent of permissions.network', async () => {
    const manifest = makeManifest({ network: ['api.example.com'], publicNetwork: ['cdn.example.com'] });
    const ctx = new SourceHost().createContext(manifest, {});
    // api.example.com is allowed for ctx.fetch but was never declared public.
    await assert.rejects(() => ctx.fetchPublic('https://api.example.com/file.ifc'));
  });

  it('strips every header down to just Accept and Range — an Authorization header can never reach the wire', async () => {
    const manifest = makeManifest({ network: [], publicNetwork: ['cdn.example.com'] });
    const ctx = new SourceHost().createContext(manifest, {});
    let capturedInit: RequestInit | undefined;

    await withFetch(
      async (_input, init) => {
        capturedInit = init;
        return new Response('ok');
      },
      () => ctx.fetchPublic('https://cdn.example.com/file.ifc', { range: 'bytes=0-1023' }),
    );

    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get('Authorization'), null);
    assert.equal(headers.get('Range'), 'bytes=0-1023');
    assert.equal(headers.get('Accept'), '*/*');
    assert.equal([...headers.keys()].length, 2);
    assert.equal(capturedInit?.credentials, 'omit');
    assert.equal(capturedInit?.redirect, 'follow');
  });
});

// ============================================================================
// Relay rewrite
// ============================================================================

describe('relay rewrite', () => {
  it('maps a declared relay upstream URL to its same-origin path, and the permission check still runs against the upstream host', async () => {
    const manifest = makeManifest({
      network: ['*.dalux.com'],
      relay: { upstream: 'https://node1.field.dalux.com/service/api', path: '/api/dalux' },
    });
    const host = new SourceHost();
    assert.equal(host.register(makeProvider(manifest.permissions)), true);
    const ctx = host.createContext(manifest, {});

    let capturedUrl: string | undefined;
    await withFetch(
      async (input) => {
        capturedUrl = typeof input === 'string' ? input : input.toString();
        return new Response('ok');
      },
      () => ctx.fetch('https://node1.field.dalux.com/service/api/files/42'),
    );

    assert.equal(capturedUrl, 'https://viewer.example.com/api/dalux/files/42');
  });

  it('still rejects a relay-mapped upstream host that permissions.network does not allow', async () => {
    const manifest = makeManifest({
      network: ['some-other-host.example.com'], // deliberately NOT node1.field.dalux.com
      relay: { upstream: 'https://node1.field.dalux.com/service/api', path: '/api/dalux' },
    });
    const ctx = new SourceHost().createContext(manifest, {});
    await assert.rejects(() => ctx.fetch('https://node1.field.dalux.com/service/api/files/42'));
  });
});
