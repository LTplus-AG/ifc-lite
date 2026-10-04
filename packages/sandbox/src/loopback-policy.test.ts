/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { parseCapability } from '@ifc-lite/extensions';
import { coreNetworkRequest, createLoopbackHostGrant, loopbackHttpOrigin } from './network-request.js';

describe('explicit loopback HTTP policy #6784', () => {
  it('allows exactly the three literal hosts with an origin and separate exact host grant', async () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const origin = `http://${host}:8080`; let calls = 0;
      const response = await coreNetworkRequest({ url: `${origin}/data`, loopbackHttpOrigin: origin, method: 'GET', timeoutMs: 1000, maxBytes: 100 },
        [createLoopbackHostGrant(host)], async () => { calls++; return new Response('original fixture'); });
      expect(response.body).toBe('original fixture'); expect(calls).toBe(1);
    }
  });
  it('rejects alias spellings, spoofing, missing grants, origin mismatch and HTTPS downgrade before dispatch', async () => {
    const origin = 'http://127.0.0.1:8080'; let calls = 0;
    const transport = async () => { calls++; return new Response('unexpected'); };
    for (const authority of ['2130706433', '0x7f000001', '127.1', '127.000.0.1', '127.0.0.2', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]', 'localhost.', 'x.localhost', 'localhost.evil.org', 'user@127.0.0.1', '%31%32%37.0.0.1']) {
      const url = `http://${authority}:8080/data`;
      expect(loopbackHttpOrigin(url)).toBeUndefined();
      await expect(coreNetworkRequest({ url, loopbackHttpOrigin: origin, method: 'GET', timeoutMs: 1000, maxBytes: 100 }, [createLoopbackHostGrant('127.0.0.1')], transport)).rejects.toThrow();
    }
    for (const url of ['http://localhost:8080\\@evil.org/', 'http://localhost:8080/\n', 'http://localhost:08080/']) {
      expect(loopbackHttpOrigin(url)).toBeUndefined();
      await expect(coreNetworkRequest({ url, loopbackHttpOrigin: 'http://localhost:8080', method: 'GET', timeoutMs: 1000, maxBytes: 100 }, [createLoopbackHostGrant('localhost')], transport)).rejects.toThrow();
    }
    for (const [url, authorization, grants] of [
      [`${origin}/data`, undefined, [createLoopbackHostGrant('127.0.0.1')]],
      [`${origin}/data`, origin, []],
      ['http://127.0.0.1:8081/data', origin, [createLoopbackHostGrant('127.0.0.1')]],
      ['http://localhost:8080/data', origin, [createLoopbackHostGrant('localhost')]],
      ['https://localhost/data', origin, [createLoopbackHostGrant('localhost')]],
    ] as const) await expect(coreNetworkRequest({ url, loopbackHttpOrigin: authorization, method: 'GET', timeoutMs: 1000, maxBytes: 100 }, grants, transport)).rejects.toThrow();
    const wildcard = parseCapability('network.fetch:*'); expect(wildcard.ok).toBe(true);
    if (wildcard.ok) await expect(coreNetworkRequest({ url: origin, loopbackHttpOrigin: origin, method: 'GET', timeoutMs: 1000, maxBytes: 100 }, [wildcard.value], transport)).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
