/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The inbound-message filter is the SDK's trust boundary: anything that gets
 * past it can resolve a pending request or fire a consumer event callback.
 * Every rejection reason is pinned in both directions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EMBED_SOURCE, PROTOCOL_VERSION } from '@ifc-lite/embed-protocol';
import { mount, DEFAULT_ORIGIN, type Harness } from './harness.js';

let h: Harness | undefined;
afterEach(() => { h?.cleanup(); h = undefined; });

describe('event.origin filtering', () => {
  it('accepts a message from the expected origin', async () => {
    h = mount({});
    const seen: unknown[] = [];
    const embed = await h.handshake();
    embed.on('entity-selected', (d) => seen.push(d));
    h.emit('ENTITY_SELECTED', { id: 7 });
    expect(seen).toEqual([{ id: 7 }]);
  });

  it('drops a message from a different origin', async () => {
    h = mount({});
    const seen: unknown[] = [];
    const embed = await h.handshake();
    embed.on('entity-selected', (d) => seen.push(d));
    h.emit('ENTITY_SELECTED', { id: 7 }, {}, { origin: 'https://evil.example.test' });
    expect(seen).toEqual([]);
  });

  it('drops a message from an origin that merely prefixes the expected one', async () => {
    h = mount({ origin: 'https://embed.ifclite.com' });
    const seen: unknown[] = [];
    const embed = await h.handshake();
    embed.on('entity-selected', (d) => seen.push(d));
    // A substring/startsWith comparison would let all of these through.
    for (const origin of [
      'https://embed.ifclite.com.evil.test',
      'https://evil.test/https://embed.ifclite.com',
      'http://embed.ifclite.com',
      'https://embed.ifclite.com:8443',
      'null',
    ]) {
      h.emit('ENTITY_SELECTED', { id: 7 }, {}, { origin });
    }
    expect(seen).toEqual([]);
  });

  it('normalises a consumer-supplied origin with a trailing slash or path', async () => {
    h = mount({ origin: 'https://embed.example.test/viewer/' });
    const seen: unknown[] = [];
    // The handshake itself only works if the canonical origin is accepted.
    const embed = await h.handshake();
    embed.on('entity-selected', (d) => seen.push(d));
    h.emit('ENTITY_SELECTED', { id: 1 }, {}, { origin: 'https://embed.example.test' });
    expect(seen).toEqual([{ id: 1 }]);
  });
});

describe('event.source filtering', () => {
  it('drops a message whose source is not our iframe window', async () => {
    h = mount({});
    const seen: unknown[] = [];
    const embed = await h.handshake();
    embed.on('entity-selected', (d) => seen.push(d));
    h.emit('ENTITY_SELECTED', { id: 7 }, {}, { source: { postMessage() {} } });
    expect(seen).toEqual([]);
  });

  it('drops a same-origin message with no source window at all', async () => {
    h = mount({});
    const seen: unknown[] = [];
    const embed = await h.handshake();
    embed.on('entity-selected', (d) => seen.push(d));
    h.emit('ENTITY_SELECTED', { id: 7 }, {}, { source: null });
    expect(seen).toEqual([]);
  });
});

describe('envelope filtering', () => {
  it('ignores traffic that lacks the embed discriminator', async () => {
    h = mount({});
    const seen: unknown[] = [];
    const embed = await h.handshake();
    embed.on('entity-selected', (d) => seen.push(d));
    h.inbound({ type: 'ENTITY_SELECTED', data: { id: 7 } });
    h.inbound({ source: 'some-other-widget', type: 'ENTITY_SELECTED', data: { id: 7 } });
    h.inbound(null);
    h.inbound('ENTITY_SELECTED');
    expect(seen).toEqual([]);
  });

  it('accepts the same payload once the discriminator is present', async () => {
    h = mount({});
    const seen: unknown[] = [];
    const embed = await h.handshake();
    embed.on('entity-selected', (d) => seen.push(d));
    h.inbound({ source: EMBED_SOURCE, version: PROTOCOL_VERSION, type: 'ENTITY_SELECTED', data: { id: 7 } });
    expect(seen).toEqual([{ id: 7 }]);
  });
});

describe('outbound targetOrigin', () => {
  it('never posts to the "*" wildcard', async () => {
    h = mount({});
    const embed = await h.handshake();
    void embed.select([1, 2]);
    expect(h.posted.length).toBeGreaterThan(0);
    for (const p of h.posted) {
      expect(p.targetOrigin).not.toBe('*');
      expect(p.targetOrigin).toBe(DEFAULT_ORIGIN);
    }
  });

  it('targets the configured origin, not the default one', async () => {
    h = mount({ origin: 'https://embed.example.test' });
    const embed = await h.handshake();
    void embed.showAll();
    expect(h.last().targetOrigin).toBe('https://embed.example.test');
  });
});
