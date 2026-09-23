/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host-supplied file-source providers registered at bootstrap (#5228).
 *
 * Driven through `SourceHostProvider`'s `additionalProviders`, the prop
 * `mountViewer({ sourceProviders })` threads down, and read back through
 * `useSourceHost()`: the host the running app would hand every consumer.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLUGIN_API_VERSION,
  type FileSourceProvider,
  type PluginManifest,
  type PluginPermissions,
} from '@ifc-lite/plugin-api';
import { cleanup, render } from '@/test/render.js';
import { SourceHostProvider, useSourceHost } from './SourceHostProvider';
import { createRegisteredProviders } from './registered-providers';
import type { FileSourceProviderFactory, SourceHost } from './source-host';

const BUILT_IN_NAMES = createRegisteredProviders().map((p) => p.manifest.name);

afterEach(cleanup);

/** The host `SourceHostProvider` builds for `additionalProviders`. */
function hostWith(additionalProviders?: readonly FileSourceProviderFactory[]): SourceHost {
  let captured: SourceHost | undefined;
  function Probe() {
    captured = useSourceHost();
    return null;
  }
  render(
    <SourceHostProvider additionalProviders={additionalProviders}>
      <Probe />
    </SourceHostProvider>,
  );
  assert.ok(captured, 'SourceHostProvider provides a host');
  return captured;
}

function fixtureProvider(
  name: string,
  overrides: { api?: string; permissions?: PluginPermissions } = {},
): FileSourceProvider {
  const manifest: PluginManifest = {
    name,
    title: `Fixture ${name}`,
    api: overrides.api ?? PLUGIN_API_VERSION,
    auth: 'preferences',
    permissions: overrides.permissions ?? { network: ['files.host.example'] },
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
  };
  return {
    manifest,
    listProjects: async () => ({ items: [] }),
    listContainers: async () => ({ items: [] }),
    listFiles: async () => ({ items: [] }),
    download: async () => new ArrayBuffer(0),
  };
}

const throwingFactory: FileSourceProviderFactory = () => {
  throw new Error('missing tenant configuration');
};

function names(providers: readonly FileSourceProvider[]): string[] {
  return providers.map((p) => p.manifest.name);
}

describe('SourceHostProvider — host-supplied providers (#5228)', () => {
  it('with no host-supplied providers, registers exactly the built-ins', () => {
    const host = hostWith();
    // Pinned, not derived from the factory list: dropping a built-in from
    // `BUILT_IN_PROVIDER_FACTORIES` must fail here, not shrink both sides.
    assert.deepEqual(names(host.list()), ['dalux-build', 'dropbox', 'msgraph-onedrive']);
    assert.deepEqual(names(host.list()), BUILT_IN_NAMES);
    assert.equal(host.getRegistrationFailures().length, 0);
  });

  it('a fixture provider supplied at bootstrap appears in list(), after the unchanged built-ins', () => {
    const fixture = fixtureProvider('host-fixture');
    const host = hostWith([() => fixture]);
    assert.deepEqual(names(host.list()), [...BUILT_IN_NAMES, 'host-fixture']);
    assert.equal(host.get('host-fixture'), fixture);
    assert.equal(host.getRegistrationFailures().length, 0);
  });

  it('a host-supplied factory that throws does not stop the built-ins or a later host-supplied provider', () => {
    const host = hostWith([throwingFactory, () => fixtureProvider('after-the-bad-one')]);
    assert.deepEqual(names(host.list()), [...BUILT_IN_NAMES, 'after-the-bad-one']);
    assert.deepEqual(host.getRegistrationFailures(), [
      { provider: 'host-supplied provider #1', reason: 'failed to construct: missing tenant configuration' },
    ]);
  });

  it('a provider whose manifest getter throws is recorded, not raised', () => {
    const broken = {
      get manifest(): PluginManifest {
        throw new Error('manifest unavailable');
      },
    } as unknown as FileSourceProvider;
    const host = hostWith([() => broken]);
    assert.deepEqual(names(host.list()), BUILT_IN_NAMES);
    assert.match(host.getRegistrationFailures()[0]?.reason ?? '', /manifest unavailable/);
  });

  it('a manifest missing its permissions block is recorded as invalid, not raised', () => {
    const noPermissions = fixtureProvider('no-permissions');
    const malformed = {
      ...noPermissions,
      manifest: { ...noPermissions.manifest, permissions: undefined },
    } as unknown as FileSourceProvider;
    const host = hostWith([() => malformed]);
    assert.equal(host.get('no-permissions'), undefined);
    const [failure] = host.getRegistrationFailures();
    assert.equal(failure?.provider, 'no-permissions');
    assert.match(failure?.reason ?? '', /^invalid manifest:/);
  });

  it('a host-supplied provider reusing a built-in name is refused and the built-in is kept', () => {
    const builtInName = BUILT_IN_NAMES[0];
    const impostor = fixtureProvider(builtInName);
    const host = hostWith([() => impostor]);
    assert.ok(host.get(builtInName));
    assert.notEqual(host.get(builtInName), impostor);
    assert.deepEqual(names(host.list()), BUILT_IN_NAMES);
    assert.match(host.getRegistrationFailures()[0]?.reason ?? '', /already registered/);
  });

  it('two host-supplied providers with the same name: the second is refused', () => {
    const first = fixtureProvider('twin');
    const host = hostWith([() => first, () => fixtureProvider('twin')]);
    assert.equal(host.get('twin'), first);
    assert.equal(host.getRegistrationFailures().length, 1);
  });

  it('an incompatible manifest.api is refused at register() time', () => {
    const host = hostWith([() => fixtureProvider('too-old', { api: '^0.1.0' })]);
    assert.equal(host.get('too-old'), undefined);
    assert.match(host.getRegistrationFailures()[0]?.reason ?? '', /requires host api "\^0\.1\.0"/);
  });

  it('a relay the host has not configured is refused', () => {
    const host = hostWith([
      () =>
        fixtureProvider('relayed', {
          permissions: {
            network: ['api.elsewhere.example'],
            relay: { upstream: 'https://api.elsewhere.example/v1', path: '/api/elsewhere' },
          },
        }),
    ]);
    assert.equal(host.get('relayed'), undefined);
    assert.match(host.getRegistrationFailures()[0]?.reason ?? '', /does not match a route this host actually has configured/);
  });
});

describe('a host-supplied provider gets the same sandboxed context as a built-in (#5228)', () => {
  async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  }

  it('fetch refuses non-https and undeclared hosts, and omits credentials and redirects on allowed ones', async () => {
    const host = hostWith([() => fixtureProvider('host-fixture')]);
    const provider = host.get('host-fixture');
    assert.ok(provider, 'the host-supplied provider is registered');
    const ctx = host.createContext(provider.manifest, {});

    const seen: RequestInit[] = [];
    await withFetch(
      async (_input, init) => {
        seen.push(init ?? {});
        return new Response('ok');
      },
      async () => {
        await assert.rejects(ctx.fetch('http://files.host.example/a'), /Only https is permitted/);
        await assert.rejects(ctx.fetch('https://other.example/a'), /not allowed to contact other\.example/);
        const response = await ctx.fetch('https://files.host.example/a', { credentials: 'include' });
        assert.equal(await response.text(), 'ok');
      },
    );
    assert.equal(seen.length, 1, 'the refused requests never reach the network');
    assert.equal(seen[0].credentials, 'omit');
    assert.equal(seen[0].redirect, 'error');
  });
});
