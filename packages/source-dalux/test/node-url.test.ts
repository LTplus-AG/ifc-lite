/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parsing the user-entered Dalux base URL (#2792).
 *
 * Dalux prints a per-customer base URL next to the API key, so users paste the
 * whole thing. Only the node NAME survives: the relay assembles the origin
 * itself, because forwarding a user-supplied host would point a relay that
 * carries the caller's API key at anywhere they name.
 */

import { describe, expect, it } from 'vitest';
import { canonicalFieldNodeUrl, daluxFieldNode, parseDaluxNode } from '../src/node-url.js';
import { BrowserDaluxApiClient } from '../src/http-client.js';

describe('parseDaluxNode', () => {
  it('keeps the node from a pasted base URL', () => {
    expect(parseDaluxNode('https://node2.field.dalux.com/service/api')).toBe('node2');
    expect(parseDaluxNode('https://node10.field.dalux.com/service/api')).toBe('node10');
    // Trailing whitespace and a missing scheme are ordinary paste damage.
    expect(parseDaluxNode('  https://node3.field.dalux.com/service/api  ')).toBe('node3');
    expect(parseDaluxNode('node4.field.dalux.com/service/api')).toBe('node4');
  });

  it('sends nothing for blank input or the default node', () => {
    // The common case must add no parameter at all, so the node1 majority is
    // byte-for-byte unaffected by this change.
    for (const blank of [undefined, null, '', '   ']) {
      expect(parseDaluxNode(blank)).toBeUndefined();
    }
    expect(parseDaluxNode('https://node1.field.dalux.com/service/api')).toBeUndefined();
  });

  it('rejects anything that is not a Dalux field node', () => {
    const hostile = [
      'https://evil.com/service/api',
      'https://node2.field.dalux.com.evil.com/service/api',
      'https://node2.evil.com',
      'https://field.dalux.com',
      'https://node0.field.dalux.com',
      'https://node.field.dalux.com',
      'https://node01.field.dalux.com',
      'https://user@evil.com',
      'not a url at all',
    ];
    for (const raw of hostile) {
      expect(() => parseDaluxNode(raw), `${raw} was accepted`).toThrow(/Not a (valid )?Dalux/);
    }
  });

  it('ignores the scheme, because only the node name is kept', () => {
    // The relay always builds https:// from the node name, so a pasted http://
    // URL cannot downgrade anything: the scheme never leaves this function.
    expect(parseDaluxNode('http://node2.field.dalux.com/service/api')).toBe('node2');
  });

  it('fails loudly on a wrong URL instead of silently using node1', () => {
    // Falling back would present as "my API key does not work", which is what
    // sent the original reporter looking in the wrong place.
    expect(() => parseDaluxNode('https://nodeX.field.dalux.com')).toThrow(/Not a Dalux node URL/);
  });
});

describe('node stamping is scoped to the relay', () => {
  it('leaves an opaque Dalux download link byte-for-byte intact', async () => {
    // Dalux returns `downloadLink` (and `nextPage`) values that can point at a
    // different host and can carry a signature computed over the query string.
    // Adding a parameter there is useless at best and breaks the signature at
    // worst, and it is not routed through the node-aware relay anyway.
    const seen: string[] = [];
    const ctx = {
      fetch: async (url: string) => {
        seen.push(url);
        return new Response(new ArrayBuffer(2), { status: 200 });
      },
      log: { debug() {}, error() {}, info() {}, warn() {} },
    } as unknown as ConstructorParameters<typeof BrowserDaluxApiClient>[1];

    const client = new BrowserDaluxApiClient(
      { baseUrl: 'https://node1.field.dalux.com/service/api', apiKey: 'k', node: 'node2' },
      ctx,
    );

    const signed = 'https://cdn.dalux.com/files/abc?Expires=1&Signature=deadbeef';
    await client.getBinary(signed);
    expect(seen[0]).toBe(signed);

    // ...including forms that `new URL(x).toString()` would silently rewrite.
    // A default port and a dot segment both normalise away, and a signature
    // computed over the original string would no longer verify. Passing the
    // ORIGINAL bytes through is the contract, not "an equivalent URL".
    const normalisable = 'https://cdn.dalux.com:443/files/./abc?Signature=deadbeef';
    expect(new URL(normalisable).toString(), 'fixture no longer demonstrates normalisation').not.toBe(
      normalisable,
    );
    await client.getBinary(normalisable);
    expect(seen[1]).toBe(normalisable);

    // ...while a relay-bound URL still gets the selector.
    await client.getBinary('https://node1.field.dalux.com/service/api/2.0/x/content');
    expect(seen[2]).toContain('daluxNode=node2');
  });

  it('does not stamp a URL whose origin merely has the relay origin as a string prefix', async () => {
    // Both `stampNode` and `nodeSelectorFor` gate on `url.origin !== <relay
    // origin>`, which is correct exact-origin equality. A same-origin check
    // implemented instead as `!origin.startsWith(relayOrigin)` would still
    // reject a wholly different host (the `cdn.dalux.com` cases above), but
    // would accept "https://node1.field.dalux.com.evil.com" — a different,
    // attacker-controlled registrable domain whose origin string literally
    // starts with the relay's. Nothing above exercises that shape.
    const seen: string[] = [];
    const ctx = {
      fetch: async (url: string) => {
        seen.push(url);
        return new Response(new ArrayBuffer(2), { status: 200 });
      },
      log: { debug() {}, error() {}, info() {}, warn() {} },
    } as unknown as ConstructorParameters<typeof BrowserDaluxApiClient>[1];

    const client = new BrowserDaluxApiClient(
      { baseUrl: 'https://node1.field.dalux.com/service/api', apiKey: 'k', node: 'node2' },
      ctx,
    );

    const lookalike = 'https://node1.field.dalux.com.evil.com/service/api/2.0/x/content';
    await client.getBinary(lookalike);
    expect(seen[0]).toBe(lookalike);
  });

  it('reroutes a downloadLink pointing at a different Dalux field node through the relay origin (#3308)', async () => {
    // A customer whose account lives on node2 (not node1) sees Dalux hand
    // back a `downloadLink`/revision-content URL built on THEIR node, using
    // the same `/service/api` REST shape our own requests use — this is not
    // the opaque-CDN-link case the tests above cover. `baseUrl` is always the
    // canonical node1 origin (see `provider.ts#createClient`), so this URL's
    // origin never matches it. Left alone, it would never be rewritten onto
    // the same-origin relay by the host (`applyRelay` in `host-fetch.ts`
    // only rewrites URLs starting with the declared relay upstream, node1),
    // and the browser would attempt a direct cross-origin fetch to Dalux —
    // which fails, because Dalux sends no CORS headers from any node. The
    // fix must land it back on the node1 origin with the real node stamped
    // as `daluxNode`, exactly like the node-preference case above.
    const seen: string[] = [];
    const ctx = {
      fetch: async (url: string) => {
        seen.push(url);
        return new Response(new ArrayBuffer(2), { status: 200 });
      },
      log: { debug() {}, error() {}, info() {}, warn() {} },
    } as unknown as ConstructorParameters<typeof BrowserDaluxApiClient>[1];

    // No `node` preference set — the account's node preference is
    // irrelevant here; what matters is the node baked into the URL itself.
    const client = new BrowserDaluxApiClient(
      { baseUrl: 'https://node1.field.dalux.com/service/api', apiKey: 'k' },
      ctx,
    );

    const otherNodeLink =
      'https://node2.field.dalux.com/service/api/2.0/projects/p1/file_areas/fa1/files/f1/revisions/r1/content?Signature=abc';
    await client.getBinary(otherNodeLink);

    expect(seen[0]).not.toBe(otherNodeLink);
    const fetched = new URL(seen[0]);
    expect(fetched.origin).toBe('https://node1.field.dalux.com');
    expect(fetched.pathname).toBe('/service/api/2.0/projects/p1/file_areas/fa1/files/f1/revisions/r1/content');
    expect(fetched.searchParams.get('daluxNode')).toBe('node2');
    expect(fetched.searchParams.get('Signature')).toBe('abc');
  });
});

describe('daluxFieldNode', () => {
  it('recognises a Dalux field-node hostname', () => {
    expect(daluxFieldNode('node1.field.dalux.com')).toBe('node1');
    expect(daluxFieldNode('node2.field.dalux.com')).toBe('node2');
    expect(daluxFieldNode('node10.field.dalux.com')).toBe('node10');
  });

  it('rejects anything that is not exactly a Dalux field node', () => {
    for (const host of [
      'cdn.dalux.com',
      'node1.field.dalux.com.evil.com',
      'node0.field.dalux.com',
      'field.dalux.com',
      'evil.com',
    ]) {
      expect(daluxFieldNode(host), host).toBeUndefined();
    }
  });
});

describe('canonicalFieldNodeUrl', () => {
  const baseUrl = 'https://node1.field.dalux.com/service/api';

  it('rewrites a different-node URL onto baseUrl, stamping the real node', () => {
    const result = canonicalFieldNodeUrl(
      'https://node3.field.dalux.com/service/api/2.0/x/content?a=b',
      baseUrl,
    );
    expect(result).toBeDefined();
    const url = new URL(result!);
    expect(url.origin).toBe('https://node1.field.dalux.com');
    expect(url.pathname).toBe('/service/api/2.0/x/content');
    expect(url.searchParams.get('daluxNode')).toBe('node3');
    expect(url.searchParams.get('a')).toBe('b');
  });

  it('returns undefined for a URL already on baseUrl’s origin', () => {
    expect(canonicalFieldNodeUrl('https://node1.field.dalux.com/service/api/2.0/x', baseUrl)).toBeUndefined();
  });

  it('returns undefined for a host that is not a Dalux field node', () => {
    expect(canonicalFieldNodeUrl('https://cdn.dalux.com/files/abc?Signature=x', baseUrl)).toBeUndefined();
  });

  it('returns undefined when the path does not share the base path', () => {
    expect(canonicalFieldNodeUrl('https://node2.field.dalux.com/other/2.0/x', baseUrl)).toBeUndefined();
  });

  it('returns undefined for an unparseable URL', () => {
    expect(canonicalFieldNodeUrl('not a url', baseUrl)).toBeUndefined();
  });

  // A bare `startsWith(base.pathname)` also admits a SIBLING path: with a base
  // of `/service/api`, `/service/api-v2/...` shares the prefix without being
  // under it. That is a different API surface, and rerouting it through the
  // relay would send a request we do not own to our own origin.
  it('returns undefined for a sibling path that merely shares the base prefix', () => {
    expect(
      canonicalFieldNodeUrl('https://node2.field.dalux.com/service/api-v2/2.0/x', baseUrl),
    ).toBeUndefined();
    expect(
      canonicalFieldNodeUrl('https://node2.field.dalux.com/service/apiary/x', baseUrl),
    ).toBeUndefined();
  });

  it('still accepts the base path exactly, and a real child of it', () => {
    expect(canonicalFieldNodeUrl('https://node2.field.dalux.com/service/api', baseUrl)).toBeDefined();
    expect(
      canonicalFieldNodeUrl('https://node2.field.dalux.com/service/api/2.0/x', baseUrl),
    ).toBeDefined();
  });
});
