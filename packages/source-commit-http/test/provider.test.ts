/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HTTP-layer behaviour the shared conformance suite cannot see: how this
 * client builds URLs, negotiates a payload format, maps statuses onto the
 * contract's error codes, and reports a capability declaration that has
 * drifted from the service.
 */

import { describe, expect, it } from 'vitest';
import { isCommitSourceError, PLUGIN_API_VERSION } from '@ifc-lite/plugin-api';

import { createCommitHttpProvider, fetchCommitCapabilities } from '../src/index.js';
import { createMockContext } from './context.js';
import { BASE_URL, createMockService } from './mock-service.js';
import { buildWorld } from './world.js';

const NETWORK = ['commits.example.com', 'id.example.com'];
const REF = { projectId: 'proj-1', modelId: 'model-structural' };

function setup(options?: Parameters<typeof createMockService>[0]) {
  const service = createMockService(options ?? { world: buildWorld() });
  const provider = createCommitHttpProvider({
    network: NETWORK,
    commits: service.fixture.manifest.capabilities.commits!,
  });
  return { service, provider, ctx: createMockContext(service) };
}

describe('manifest', () => {
  it('requires the contract version that introduced the commit API', () => {
    const { provider } = setup();
    expect(provider.manifest.api).toBe(`^${PLUGIN_API_VERSION}`);
    expect(provider.manifest.auth).toBe('interactive');
    expect(provider.manifest.permissions.network).toEqual(NETWORK);
  });

  it('declares no file-store capabilities, because a commit service is not one', () => {
    const { provider } = setup();
    const capabilities = provider.manifest.capabilities;
    expect(capabilities.revisionHistory).toBe(false);
    expect(capabilities.changeDetection).toBe(false);
    expect(capabilities.search).toBe(false);
    expect(provider.listRevisions).toBeUndefined();
  });

  it('omits a method whose declared flag is false', () => {
    const service = createMockService({ world: buildWorld() });
    const provider = createCommitHttpProvider({
      network: NETWORK,
      commits: { ...service.fixture.manifest.capabilities.commits!, storedDiffs: false, write: false },
    });
    expect(provider.getCommitDiff).toBeUndefined();
    expect(provider.createCommit).toBeUndefined();
    // Still present: the flags that stayed on.
    expect(typeof provider.listElementHistory).toBe('function');
  });
});

describe('URL construction', () => {
  it('keeps the base URL path prefix', async () => {
    const { provider, ctx, service } = setup();
    await provider.listCommits!(ctx, REF, { limit: 2 });
    const request = service.requests.at(-1)!;
    // `new URL('/projects', 'https://host/api/v1')` drops `/api/v1`, which is
    // the classic way a generic client works in staging and 404s in prod.
    expect(request.url.startsWith(`${BASE_URL}/projects/proj-1/models/model-structural/commits`)).toBe(true);
  });

  it('sends list options as query parameters, omitting the ones not supplied', async () => {
    const { provider, ctx, service } = setup();
    await provider.listCommits!(ctx, REF, { limit: 5, includeUnpublished: true });
    const url = new URL(service.requests.at(-1)!.url);
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('includeUnpublished')).toBe('true');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.has('before')).toBe(false);
  });

  it('percent-encodes an element key into the history path', async () => {
    const { provider, ctx, service } = setup();
    await provider.listElementHistory!(ctx, { ...REF, key: 'wall a/2' }).catch(() => undefined);
    expect(service.requests.at(-1)!.url).toContain('/elements/wall%20a%2F2/history');
  });
});

describe('payload negotiation', () => {
  it('asks for the media types of the accepted formats, in the host order', async () => {
    const { provider, ctx, service } = setup();
    await provider.loadCommit!(ctx, { ...REF, commitId: 'c1' }, { accept: ['ifcx', 'ifc-step'] });
    expect(service.requests.at(-1)!.accept).toBe('application/json, application/x-step');
  });

  it('carries the artifact digest and file name off the response headers', async () => {
    const { provider, ctx } = setup();
    const commit = await provider.getCommit!(ctx, { ...REF, commitId: 'c1' });
    const payload = await provider.loadCommit!(ctx, { ...REF, commitId: 'c1' });
    expect(payload.artifactDigest).toBe(commit.artifact.digest);
    expect(payload.fileName).toBe('structural-c1.ifc');
    expect(new TextDecoder().decode(payload.bytes)).toBe('COMMIT-1::initial-delivery');
  });

  it('refuses a format the service does not serve, without a round trip', async () => {
    const { provider, ctx, service } = setup({ world: buildWorld(), payloadFormats: ['ifc-step'] });
    const before = service.requests.length;
    await expect(
      provider.loadCommit!(ctx, { ...REF, commitId: 'c1' }, { accept: ['ifc-zip'] }),
    ).rejects.toMatchObject({ code: 'unsupported-format' });
    // Nothing was sent: the client already knows what the service serves, so
    // asking would waste a request and produce a worse error message.
    expect(service.requests.length).toBe(before);
  });
});

describe('error mapping', () => {
  it('turns the service JSON error body into a narrowable code', async () => {
    const { provider, ctx } = setup();
    try {
      await provider.getCommit!(ctx, { ...REF, commitId: 'nope' });
      expect.fail('getCommit resolved for a commit that does not exist');
    } catch (error) {
      expect(isCommitSourceError(error)).toBe(true);
      if (isCommitSourceError(error)) expect(error.code).toBe('not-found');
    }
  });

  it('carries `details` through, so a conflict names the live head', async () => {
    const { provider, ctx } = setup();
    try {
      await provider.createCommit!(ctx, {
        projectId: 'proj-1',
        modelId: 'model-uploads',
        expectedParentId: 'stale',
        fileName: 'x.ifc',
        bytes: new TextEncoder().encode('x').buffer as ArrayBuffer,
        idempotencyKey: 'k-conflict',
      });
      expect.fail('createCommit accepted a stale parent');
    } catch (error) {
      expect(isCommitSourceError(error)).toBe(true);
      if (isCommitSourceError(error)) {
        expect(error.code).toBe('conflict');
        expect(error.details?.headCommitId).toBe('u1');
      }
    }
  });

  it('reads 202 as not-ready with a delay, not as a successful body', async () => {
    const service = createMockService({ world: buildWorld() });
    const inner = service.fetch;
    let served = false;
    const flaky: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!served && url.includes('/diff')) {
        served = true;
        return new Response(JSON.stringify({ code: 'not-ready', message: 'Calculating changes' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '2' },
        });
      }
      return inner(input, init);
    };
    const provider = createCommitHttpProvider({
      network: NETWORK,
      commits: service.fixture.manifest.capabilities.commits!,
    });
    const ctx = createMockContext({ ...service, fetch: flaky });

    try {
      await provider.getCommitDiff!(ctx, { ...REF, commitId: 'c1' }, { ...REF, commitId: 'c3' });
      expect.fail('a 202 was treated as a successful diff');
    } catch (error) {
      expect(isCommitSourceError(error)).toBe(true);
      if (isCommitSourceError(error)) {
        expect(error.code).toBe('not-ready');
        // A host's retry loop has nothing to wait on without this; the
        // Retry-After header is the fallback when the body omits it.
        expect(error.retryAfterMs).toBe(2000);
      }
    }

    // The retry succeeds, which is what makes `not-ready` a wait rather than a failure.
    const diff = await provider.getCommitDiff!(ctx, { ...REF, commitId: 'c1' }, { ...REF, commitId: 'c3' });
    expect(diff.counts.added).toBe(1);
  });

  it('falls back to the status when the service sends no usable code', async () => {
    const service = createMockService({ world: buildWorld() });
    const provider = createCommitHttpProvider({
      network: NETWORK,
      commits: service.fixture.manifest.capabilities.commits!,
    });
    // A proxy's own HTML 502 page — no JSON, no code, and the host still has
    // to render something a user can act on.
    const ctx = createMockContext({
      ...service,
      fetch: async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    });
    try {
      await provider.getModel!(ctx, REF);
      expect.fail('getModel resolved on a 502');
    } catch (error) {
      expect(isCommitSourceError(error)).toBe(true);
      if (isCommitSourceError(error)) expect(error.code).toBe('unavailable');
    }
  });
});

describe('decoding', () => {
  it('preserves the commit fields the History UI renders', async () => {
    const { provider, ctx } = setup();
    const page = await provider.listCommits!(ctx, REF, { limit: 10 });
    const c3 = page.items.find((commit) => commit.id === 'c3')!;
    expect(c3.message).toBe('Update slab openings level 3');
    expect(c3.author?.displayName).toBe('J. Hansen');
    expect(c3.parents).toEqual(['c2']);
    expect(c3.status).toBe('published');
    expect(c3.stats).toEqual({ added: 1, modified: 1, deleted: 0, unchanged: 1 });
  });

  it('keeps an empty headCommitId as empty rather than rejecting it', async () => {
    const service = createMockService({ world: buildWorld() });
    const provider = createCommitHttpProvider({
      network: NETWORK,
      commits: service.fixture.manifest.capabilities.commits!,
    });
    const ctx = createMockContext(service);
    const created = await provider.createModel!(ctx, { projectId: 'proj-1', name: 'Fresh' });
    // '' is the contract's "no commits yet"; a decoder that required a
    // non-empty string would fail on every newly created model.
    expect(created.headCommitId).toBe('');
  });

  it('rejects a malformed commit rather than handing a half-built object upward', async () => {
    const service = createMockService({ world: buildWorld() });
    const provider = createCommitHttpProvider({
      network: NETWORK,
      commits: service.fixture.manifest.capabilities.commits!,
    });
    const ctx = createMockContext({
      ...service,
      fetch: async () =>
        new Response(JSON.stringify({ id: 'c1', modelId: 'm', projectId: 'p', createdAt: '2026-01-01' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    await expect(provider.getCommit!(ctx, { ...REF, commitId: 'c1' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('testConnection', () => {
  it('reports a healthy service', async () => {
    const { provider, ctx } = setup();
    const result = await provider.testConnection!(ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('commit API available');
  });

  it('names the flags on which the registered declaration disagrees with the service', async () => {
    const service = createMockService({ world: buildWorld() });
    const provider = createCommitHttpProvider({
      network: NETWORK,
      commits: { ...service.fixture.manifest.capabilities.commits!, write: false },
    });
    const result = await provider.testConnection!(createMockContext(service));
    // The connection works, so `ok` stays true — but a manifest fixed at
    // registration is the one thing nothing else would ever notice drifting.
    expect(result.ok).toBe(true);
    expect(result.message).toContain('write declared false, service reports true');
  });

  it('reports a configuration problem instead of throwing', async () => {
    const service = createMockService({ world: buildWorld() });
    const provider = createCommitHttpProvider({
      network: NETWORK,
      commits: service.fixture.manifest.capabilities.commits!,
    });
    const ctx = createMockContext(service, { baseUrl: '' });
    const result = await provider.testConnection!(ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('baseUrl');
  });
});

describe('fetchCommitCapabilities', () => {
  it('reads the service document before any provider exists', async () => {
    const service = createMockService({ world: buildWorld() });
    const capabilities = await fetchCommitCapabilities(BASE_URL, service.fetch);
    expect(capabilities.payloadFormats).toEqual(['ifc-step', 'ifcx']);
    expect(capabilities.write).toBe(true);
  });

  it('defaults an unknown flag to false rather than claiming support', async () => {
    const capabilities = await fetchCommitCapabilities(
      BASE_URL,
      async () =>
        new Response(JSON.stringify({ commits: { payloadFormats: ['ifc-step', 'ifc-holo'], storedDiffs: 'yes' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    expect(capabilities.payloadFormats).toEqual(['ifc-step']);
    expect(capabilities.storedDiffs).toBe(false);
  });
});
