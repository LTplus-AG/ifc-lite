/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsonResponse } from '@/test/fetch-stub';
import { loadViewerRuntimeConfig, parseViewerRuntimeConfig, ViewerConfigError } from './runtime-config';

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
      // Members this viewer does not read (later versions add some) are dropped, not refused.
      server: { url: '/v1/viewing/processor' },
      somethingNewer: true,
    });
    assert.deepEqual(config, {
      version: 1,
      features: { default: 'none', enable: ['tools.measure'], disable: undefined },
      locale: 'de-CH',
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
  ];
  for (const [what, value] of refused) {
    it(`refuses ${what}`, () => {
      assert.throws(() => parseViewerRuntimeConfig(value), (error) => error instanceof ViewerConfigError && error.code === 'invalid');
    });
  }
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
