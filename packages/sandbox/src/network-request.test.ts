/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `network-request.ts` against a real local `node:http` server (127.0.0.1,
 * ephemeral port — no mocked fetch, per repo rules). Covers:
 *   - the https-only + exact-host grant gate (`coreNetworkRequest`),
 *     including the tricky hostname-spoofing cases the module doc promises
 *     are rejected;
 *   - redirect refusal, oversize-body capping, and timeout, exercised
 *     against the plain-http server via `executeUngatedRequest` (the
 *     scheme-agnostic mechanics `coreNetworkRequest` sits on top of).
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCapability, type Capability } from '@ifc-lite/extensions';
import { coreNetworkRequest, executeUngatedRequest, isHostGranted, NetworkDeniedError } from './network-request.js';
import { buildNetworkNamespace } from './bridge-network.js';

function grant(raw: string): Capability {
  const parsed = parseCapability(raw);
  if (!parsed.ok) throw new Error(`bad test fixture capability "${raw}"`);
  return parsed.value;
}

describe('network-request — https + exact-host grant gate', () => {
  it('rejects a non-https URL before any grant is consulted', async () => {
    await expect(
      coreNetworkRequest({ url: 'http://api.example.com/', method: 'GET', timeoutMs: 1000, maxBytes: 1024 }, [grant('network.fetch:*')]),
    ).rejects.toThrow(NetworkDeniedError);
  });

  it('rejects a granted host reached over http', async () => {
    await expect(
      coreNetworkRequest({ url: 'http://api.example.com/', method: 'GET', timeoutMs: 1000, maxBytes: 1024 }, [grant('network.fetch:api.example.com')]),
    ).rejects.toThrow(/https/);
  });

  it('rejects an https host with no matching grant', async () => {
    await expect(
      coreNetworkRequest({ url: 'https://api.example.com/', method: 'GET', timeoutMs: 1000, maxBytes: 1024 }, []),
    ).rejects.toThrow(NetworkDeniedError);
  });

  it('accepts an exact-host grant match (hostname parsed via new URL)', () => {
    expect(isHostGranted([grant('network.fetch:api.example.com')], 'api.example.com')).toBe(true);
  });

  it('rejects a suffix-spoofed host ("api.example.com.evil.net")', () => {
    expect(isHostGranted([grant('network.fetch:api.example.com')], 'api.example.com.evil.net')).toBe(false);
  });

  it('rejects userinfo tricks by matching only new URL(...).hostname', () => {
    // `new URL` parses "https://user@api.example.com@evil.net/" with
    // hostname "evil.net" — the userinfo before the LAST "@" is discarded,
    // so a grant for the real, intended host must not match.
    const url = new URL('https://user@api.example.com@evil.net/');
    expect(url.hostname).toBe('evil.net');
    expect(isHostGranted([grant('network.fetch:api.example.com')], url.hostname)).toBe(false);
  });

  it('does not let a grant for a subdomain cover its parent, or vice versa', () => {
    expect(isHostGranted([grant('network.fetch:api.example.com')], 'example.com')).toBe(false);
    expect(isHostGranted([grant('network.fetch:example.com')], 'api.example.com')).toBe(false);
  });

  it('a single-label wildcard grant matches one label only, never across dots', () => {
    expect(isHostGranted([grant('network.fetch:*.example.com')], 'api.example.com')).toBe(true);
    expect(isHostGranted([grant('network.fetch:*.example.com')], 'a.b.example.com')).toBe(false);
    expect(isHostGranted([grant('network.fetch:*.example.com')], 'example.com')).toBe(false);
  });

  it('rejects a data: or file: URL outright', async () => {
    await expect(
      coreNetworkRequest({ url: 'data:text/plain,hi', method: 'GET', timeoutMs: 1000, maxBytes: 1024 }, [grant('network.fetch:*')]),
    ).rejects.toThrow(NetworkDeniedError);
    await expect(
      coreNetworkRequest({ url: 'file:///etc/passwd', method: 'GET', timeoutMs: 1000, maxBytes: 1024 }, [grant('network.fetch:*')]),
    ).rejects.toThrow(NetworkDeniedError);
  });
});

describe('network-request — mechanics against a real local http server', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://evil.example.invalid/stolen' });
        res.end();
        return;
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        // Stream well past a small cap, one chunk at a time, so the reader
        // sees it incrementally rather than as one buffered write.
        let sent = 0;
        const chunk = 'x'.repeat(1024);
        const timer = setInterval(() => {
          if (sent >= 200 * 1024 || res.writableEnded) {
            clearInterval(timer);
            res.end();
            return;
          }
          res.write(chunk);
          sent += chunk.length;
        }, 1);
        req.on('close', () => clearInterval(timer));
        return;
      }
      if (req.url === '/slow') {
        // Never responds inside the test's timeout budget.
        return;
      }
      if (req.url === '/headers-echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.headers));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('refuses a redirect rather than following it', async () => {
    const url = new URL(`${baseUrl}/redirect`);
    await expect(
      executeUngatedRequest(url, { method: 'GET', timeoutMs: 2000, maxBytes: 1024 * 1024 }),
    ).rejects.toThrow(NetworkDeniedError);
  });

  it('caps an oversize response body mid-stream without buffering it whole first', async () => {
    const url = new URL(`${baseUrl}/big`);
    const res = await executeUngatedRequest(url, { method: 'GET', timeoutMs: 5000, maxBytes: 4096 });
    expect(res.truncated).toBe(true);
    // Exactly the cap: `<= 4096` also passed for a body that dropped every chunk.
    expect(res.body.length).toBe(4096);
  }, 10_000);

  it('times out a request that never responds', async () => {
    const url = new URL(`${baseUrl}/slow`);
    await expect(
      executeUngatedRequest(url, { method: 'GET', timeoutMs: 200, maxBytes: 1024 }),
    ).rejects.toThrow(/timed out/);
  }, 5_000);

  it('honours the caller-supplied AbortSignal independently of the timeout', async () => {
    const url = new URL(`${baseUrl}/slow`);
    const controller = new AbortController();
    const promise = executeUngatedRequest(url, { method: 'GET', timeoutMs: 5000, maxBytes: 1024, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it('strips Host/Cookie/hop-by-hop headers from the caller-supplied set', async () => {
    const url = new URL(`${baseUrl}/headers-echo`);
    const res = await executeUngatedRequest(url, {
      method: 'GET',
      timeoutMs: 2000,
      maxBytes: 4096,
      headers: { 'x-mine': 'keep-me', cookie: 'session=stolen', 'proxy-authorization': 'Basic xyz' },
    });
    const echoed = JSON.parse(res.body) as Record<string, string>;
    expect(echoed['x-mine']).toBe('keep-me');
    expect(echoed.cookie).toBeUndefined();
    expect(echoed['proxy-authorization']).toBeUndefined();
  });

  it('a granted GET round-trips a plain 200 response', async () => {
    const url = new URL(`${baseUrl}/`);
    const res = await executeUngatedRequest(url, { method: 'GET', timeoutMs: 2000, maxBytes: 4096 });
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    expect(res.truncated).toBe(false);
  });
});

describe('bim.network.fetch — declared type (#5446 review)', () => {
  it('declares a Promise, because the bridge call is async', () => {
    // A synchronous declaration let `bim.network.fetch(url).status`
    // type-check while reading `status` off the Promise.
    const fetchMethod = buildNetworkNamespace([]).methods.find((m) => m.name === 'fetch');
    expect(fetchMethod?.tsReturn).toMatch(/^Promise<\{ status: number;/);
  });
});

describe('coreNetworkRequest — bounds (#5446 review)', () => {
  it('refuses a non-finite or negative maxBytes before any request, since NaN would disable the cap', async () => {
    const grants = [parseCapability('network.fetch:api.example.com')].map((r) => {
      if (!r.ok) throw new Error('bad capability');
      return r.value;
    });
    let called = false;
    const transport = async () => { called = true; return new Response('x'); };
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await expect(coreNetworkRequest(
        { url: 'https://api.example.com/', method: 'GET', timeoutMs: 1000, maxBytes }, grants, transport,
      )).rejects.toThrow(/maxBytes must be a finite number/);
    }
    expect(called).toBe(false);
  });
});

describe('coreNetworkRequest — cancellation (#5446 review)', () => {
  it('reports a cancelled request as cancelled, not as a timeout', async () => {
    const parsed = parseCapability('network.fetch:api.example.com');
    if (!parsed.ok) throw new Error('bad capability');
    const controller = new AbortController();
    controller.abort();
    const transport = async (_url: URL, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response('x');
    };
    await expect(coreNetworkRequest(
      { url: 'https://api.example.com/', method: 'GET', timeoutMs: 60_000, maxBytes: 1024, signal: controller.signal },
      [parsed.value], transport,
    )).rejects.toThrow('network.fetch cancelled');
  });
});

describe('the package boundary (#5446 review)', () => {
  it('publishes only the gated request, never the ungated primitive', async () => {
    const entry = await import('./index.js');
    expect('coreNetworkRequest' in entry).toBe(true);
    expect('executeUngatedRequest' in entry).toBe(false);
  }, 60_000); // the entry loads the whole bridge (QuickJS, esbuild-wasm)
});
