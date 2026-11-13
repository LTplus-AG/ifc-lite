/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse } from '@/test/fetch-stub';
import { normalizeProcessedModelHash } from '@ifc-lite/server-client';
import { loadViewerRuntimeConfig, parseViewerRuntimeConfig, ViewerConfigError } from './runtime-config';

const SHA = 'a91f9cf15d3f70fdd707d8567b5ade051e706af3a807367fa23fc9813f31d96a';

const PAGE = 'https://host.example/viewer/?context=version-42&lang=de';

interface Call { url: string; init: RequestInit | undefined }

/** A `fetch` that records its calls and answers with `respond`. */
function fakeFetch(respond: () => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}


async function rejection(promise: Promise<unknown>): Promise<ViewerConfigError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ViewerConfigError, `expected a ViewerConfigError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the configuration to be refused');
}

describe('the version 1 configuration shape', () => {
  it('accepts the full shape and keeps what it knows', () => {
    const config = parseViewerRuntimeConfig({
      version: 1,
      features: { default: 'none', enable: ['tools.measure'] },
      locale: 'de-CH',
      server: { url: '/v1/viewing/processor', retries: 3 },
      open: { processedModel: { sha256: SHA.toUpperCase(), bytes: 18_587_273, name: 'Haus A.ifc', revision: 2 } },
      // Members this viewer does not read (later versions add some) are dropped, not refused.
      somethingNewer: true,
    });
    assert.deepEqual(config, {
      version: 1,
      features: { default: 'none', enable: ['tools.measure'], disable: undefined },
      locale: 'de-CH',
      server: { url: '/v1/viewing/processor' },
      // The hash is kept in the lowercase form the server keys by.
      open: { processedModel: { sha256: SHA, bytes: 18_587_273, name: 'Haus A.ifc' } },
    });
  });

  it('accepts the smallest config', () => {
    assert.deepEqual(parseViewerRuntimeConfig({ version: 1 }), { version: 1 });
  });

  const refused: Array<[string, unknown]> = [
    ['a non-object', 'all'],
    ['an array', []],
    ['a missing version', { features: { default: 'all' } }],
    ['another version', { version: 2 }],
    ['an unknown default', { version: 1, features: { default: 'some' } }],
    ['features that are not an object', { version: 1, features: ['ai.assistant'] }],
    ['a disable list that is not strings', { version: 1, features: { default: 'all', disable: [1] } }],
    ['an enable list that is not a list', { version: 1, features: { default: 'none', enable: 'tools.measure' } }],
    ['an empty locale', { version: 1, locale: ' ' }],
    ['a server that is not an object', { version: 1, server: '/v1/viewing/processor' }],
    ['a server without a url', { version: 1, server: {} }],
    ['an empty server url', { version: 1, server: { url: '' } }],
    ['a server url on another scheme', { version: 1, server: { url: 'javascript:alert(1)' } }],
    ['a relative server path', { version: 1, server: { url: 'v1/viewing/processor' } }],
    ['a protocol-relative server url', { version: 1, server: { url: '//elsewhere.example/processor' } }],
    ['an http server url from an https page', { version: 1, server: { url: 'http://processor.example' } }],
    // Dot segments that normalize to `//host` would send every request off-origin.
    ['a server path that normalizes to another host', { version: 1, server: { url: '/x/..//evil.example' } }],
    ['a server path with an encoded dot segment to another host', { version: 1, server: { url: '/a/%2e%2e//evil.example' } }],
    ['a server path whose backslash makes it another host', { version: 1, server: { url: '/\\evil.example' } }],
    // The client appends `/api/v1/...` to the URL, so a query or fragment would swallow the endpoint.
    ['a server path with a query', { version: 1, server: { url: '/processor?token=x' } }],
    ['a server path with a fragment', { version: 1, server: { url: '/processor#a' } }],
    ['a server url with a query', { version: 1, server: { url: 'https://processor.example/x?token=x' } }],
    ['a server url with a fragment', { version: 1, server: { url: 'https://processor.example/x#a' } }],
    ['a server url with an empty query', { version: 1, server: { url: 'https://processor.example/x?' } }],
    ['a server url with an empty fragment', { version: 1, server: { url: 'https://processor.example/x#' } }],
    ['a server url with credentials', { version: 1, server: { url: 'https://user:pass@processor.example' } }],
    ['an empty processed model name', { version: 1, open: { processedModel: { sha256: SHA, bytes: 1, name: '  ' } } }],
    ['an open without a processed model', { version: 1, open: {} }],
    ['a processed model whose hash is not a SHA-256', { version: 1, open: { processedModel: { sha256: '../../etc', bytes: 1, name: 'x.ifc' } } }],
    ['a processed model without a size', { version: 1, open: { processedModel: { sha256: SHA, name: 'x.ifc' } } }],
    ['a processed model with a negative size', { version: 1, open: { processedModel: { sha256: SHA, bytes: -1, name: 'x.ifc' } } }],
    ['a processed model with a fractional size', { version: 1, open: { processedModel: { sha256: SHA, bytes: 1.5, name: 'x.ifc' } } }],
    ['a processed model without a name', { version: 1, open: { processedModel: { sha256: SHA, bytes: 1 } } }],
  ];
  for (const [what, value] of refused) {
    it(`refuses ${what}`, () => {
      assert.throws(() => parseViewerRuntimeConfig(value, PAGE), (error) => error instanceof ViewerConfigError && error.code === 'invalid');
    });
  }

  it('keeps the server url in normalized form', () => {
    assert.deepEqual(parseViewerRuntimeConfig({ version: 1, server: { url: '  /v1/viewing/./processor ' } }, PAGE).server, { url: '/v1/viewing/processor' });
    assert.deepEqual(parseViewerRuntimeConfig({ version: 1, server: { url: 'https://processor.example' } }, PAGE).server, { url: 'https://processor.example/' });
  });

  it('accepts an http server url only from an http page', () => {
    assert.deepEqual(parseViewerRuntimeConfig({ version: 1, server: { url: 'http://localhost:8080/ifc' } }, 'http://localhost:5173/viewer/').server, { url: 'http://localhost:8080/ifc' });
  });

  it('accepts exactly the hashes the server client accepts', () => {
    // The check is copied, not imported (it runs before the configuration request); this pins the two together.
    for (const sha256 of [SHA, SHA.toUpperCase(), '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `${'a'.repeat(62)}/x`]) {
      const viaConfig = (() => {
        try { return parseViewerRuntimeConfig({ version: 1, open: { processedModel: { sha256, bytes: 0, name: 'x.ifc' } } }).open?.processedModel.sha256; }
        catch { return null; }
      })();
      assert.equal(viaConfig, normalizeProcessedModelHash(sha256), sha256);
    }
  });
});

describe('fetching the host configuration', () => {
  it('asks its own origin, with the session and the page context', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ version: 1, features: { default: 'all', disable: ['ai.assistant'] } }));
    const config = await loadViewerRuntimeConfig({ url: '/v1/viewer/config', pageUrl: PAGE, fetch });
    assert.deepEqual(config.features, { default: 'all', enable: undefined, disable: ['ai.assistant'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://host.example/v1/viewer/config?context=version-42');
    assert.equal(calls[0].init?.credentials, 'same-origin');
  });

  it('resolves a relative URL against the page and adds no context the page lacks', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ version: 1 }));
    await loadViewerRuntimeConfig({ url: 'viewer-config.json', pageUrl: 'https://host.example/viewer/index.html', fetch });
    assert.equal(calls[0].url, 'https://host.example/viewer/viewer-config.json');
  });

  it('refuses another origin without sending a request', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ version: 1 }));
    const error = await rejection(loadViewerRuntimeConfig({ url: 'https://elsewhere.example/config.json', pageUrl: PAGE, fetch }));
    assert.equal(error.code, 'cross-origin');
    assert.equal(calls.length, 0, 'the session must not be offered to another origin');
  });

  it('refuses an answer that was redirected to another origin', async () => {
    const redirected = jsonResponse({ version: 1 });
    Object.defineProperty(redirected, 'url', { value: 'https://elsewhere.example/config.json' });
    const { fetch } = fakeFetch(() => redirected);
    assert.equal((await rejection(loadViewerRuntimeConfig({ url: '/config', pageUrl: PAGE, fetch }))).code, 'cross-origin');
  });

  it('fails closed on a server error, even one with a usable body', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ version: 1 }, 500));
    assert.equal((await rejection(loadViewerRuntimeConfig({ url: '/config', pageUrl: PAGE, fetch }))).code, 'status');
  });

  it('fails closed when the request cannot be made', async () => {
    const { fetch } = fakeFetch(() => { throw new TypeError('Failed to fetch'); });
    assert.equal((await rejection(loadViewerRuntimeConfig({ url: '/config', pageUrl: PAGE, fetch }))).code, 'unreachable');
  });

  it('fails closed on a body that is not JSON, such as a sign-in page', async () => {
    const { fetch } = fakeFetch(() => new Response('<!doctype html><title>Sign in</title>', { status: 200 }));
    assert.equal((await rejection(loadViewerRuntimeConfig({ url: '/config', pageUrl: PAGE, fetch }))).code, 'not-json');
  });

  it('fails closed on JSON of the wrong shape', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ features: { default: 'none' } }));
    assert.equal((await rejection(loadViewerRuntimeConfig({ url: '/config', pageUrl: PAGE, fetch }))).code, 'invalid');
  });

  it('gives up on a request that never answers, as unreachable', async () => {
    const silent = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as typeof fetch;
    const started = Date.now();
    const error = await rejection(loadViewerRuntimeConfig({ url: '/config', pageUrl: PAGE, fetch: silent, timeoutMs: 30 }));
    assert.equal(error.code, 'unreachable');
    assert.ok(Date.now() - started < 5_000, 'ended by the timeout, not by the test runner');
  });

  it('gives up on a body that stops arriving, as unreachable', async () => {
    const stalled = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"version":'));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    const error = await rejection(loadViewerRuntimeConfig({ url: '/config', pageUrl: PAGE, fetch: stalled, timeoutMs: 30 }));
    assert.equal(error.code, 'unreachable');
  });
});
