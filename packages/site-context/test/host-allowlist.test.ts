/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The swisstopo host allowlist that the CLI and the viewer fetch through.
 * Nothing here reaches geo.admin.ch. The redirect case uses the real `fetch`
 * against a local server standing in for a swisstopo host, which answers 302
 * to a second local server playing "another host".
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAllowedSwisstopoUrl, SiteContextHostRefused, swisstopoOnlyFetch, SWISSTOPO_HOSTS } from '../src/index.js';

describe('swisstopo host allowlist', () => {
  it('admits https on every swisstopo host and nothing that only looks like one', () => {
    for (const host of SWISSTOPO_HOSTS) expect(isAllowedSwisstopoUrl(`https://${host}/x`)).toBe(true);
    for (const url of [
      'http://api3.geo.admin.ch/x', // not https
      'https://api3.geo.admin.ch:8443/x', // not the default port
      'https://api3.geo.admin.ch.evil.test/x', // suffix lookalike
      'https://evil.test/?u=https://api3.geo.admin.ch/', // swisstopo only in the query
      'https://geo.admin.ch/x', // the parent domain is not a service host
      'not a url',
    ]) expect(isAllowedSwisstopoUrl(url), url).toBe(false);
  });

  it('refuses another host before anything is sent', async () => {
    const sent: string[] = [];
    const f = swisstopoOnlyFetch(async (input) => { sent.push(input); return new Response('x'); });
    await expect(f('https://evil.test/tileset.json')).rejects.toBeInstanceOf(SiteContextHostRefused);
    expect(sent).toEqual([]);
    await f('https://3d.geo.admin.ch/tileset.json');
    expect(sent).toEqual(['https://3d.geo.admin.ch/tileset.json']);
  });

  describe('a redirect to another host', () => {
    let other: Server;
    let swisstopo: Server;
    let otherHits = 0;
    let swisstopoBase = '';

    beforeAll(async () => {
      other = createServer((_req, res) => { otherHits += 1; res.end('elsewhere'); });
      await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
      const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/stolen`;
      swisstopo = createServer((_req, res) => { res.writeHead(302, { location: otherUrl }); res.end(); });
      await new Promise<void>((r) => swisstopo.listen(0, '127.0.0.1', r));
      swisstopoBase = `http://127.0.0.1:${(swisstopo.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await Promise.all([other, swisstopo].map((s) => new Promise((r) => s.close(r))));
    });

    it('is not followed: the request fails and the other host is never contacted', async () => {
      // The real fetch, with the allowlisted URL pointed at the local stand-in.
      const f = swisstopoOnlyFetch((input, init) => globalThis.fetch(input.replace('https://data.geo.admin.ch', swisstopoBase), init));
      await expect(f('https://data.geo.admin.ch/asset.tif')).rejects.toThrow();
      expect(otherHits).toBe(0);
      // Control: the same real fetch without the wrapper follows the redirect to the other host.
      await globalThis.fetch(`${swisstopoBase}/asset.tif`);
      expect(otherHits).toBe(1);
    });
  });
});
