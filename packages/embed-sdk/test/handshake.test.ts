/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { EMBED_SOURCE, PROTOCOL_VERSION } from '@ifc-lite/embed-protocol';
import { mount, type Harness } from './harness.js';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
  vi.useRealTimers();
});

describe('READY → INIT → INIT_ACK handshake', () => {
  it('sends nothing before READY arrives', () => {
    h = mount({});
    expect(h.posted).toEqual([]);
  });

  it('sends INIT in response to READY, stamped with source and version', () => {
    h = mount({ token: 'tok-123' });
    h.emit('READY', { version: PROTOCOL_VERSION });
    expect(h.posted).toHaveLength(1);
    expect(h.last().msg).toEqual({
      source: EMBED_SOURCE,
      version: PROTOCOL_VERSION,
      type: 'INIT',
      data: { token: 'tok-123' },
    });
  });

  it('sends the token via postMessage with an undefined token when none is configured', () => {
    h = mount({});
    h.emit('READY', { version: PROTOCOL_VERSION });
    expect((h.last().msg as { data: { token?: string } }).data.token).toBeUndefined();
  });

  it('does not resolve create() on READY alone', async () => {
    h = mount({});
    h.emit('READY', { version: PROTOCOL_VERSION });
    const settled = await Promise.race([
      h.created.then(() => 'resolved'),
      Promise.resolve('pending'),
    ]);
    expect(settled).toBe('pending');
  });

  it('resolves create() once INIT_ACK arrives', async () => {
    h = mount({});
    h.emit('READY', { version: PROTOCOL_VERSION });
    h.emit('INIT_ACK');
    await expect(h.created).resolves.toBeDefined();
  });

  it('resolves on INIT_ACK even if READY was never seen', async () => {
    // The viewer may have emitted READY before the host listener attached.
    h = mount({});
    h.emit('INIT_ACK');
    await expect(h.created).resolves.toBeDefined();
    expect(h.posted).toEqual([]);
  });

  it('sends INIT only once even if READY is repeated', () => {
    h = mount({});
    h.emit('READY', { version: PROTOCOL_VERSION });
    h.emit('READY', { version: PROTOCOL_VERSION });
    h.emit('READY', { version: PROTOCOL_VERSION });
    expect(h.posted.filter(p => p.msg.type === 'INIT')).toHaveLength(1);
  });

  it('ignores a READY that fails the origin check', () => {
    h = mount({});
    h.emit('READY', { version: PROTOCOL_VERSION }, {}, { origin: 'https://evil.example.test' });
    expect(h.posted).toEqual([]);
  });
});

describe('handshake timeout', () => {
  it('rejects after the default 15s when the viewer never answers', async () => {
    vi.useFakeTimers();
    h = mount({});
    const assertion = expect(h.created).rejects.toThrow(/handshake timed out/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('does not reject one tick before the deadline', async () => {
    vi.useFakeTimers();
    h = mount({});
    await vi.advanceTimersByTimeAsync(14_999);
    const settled = await Promise.race([
      h.created.then(() => 'resolved', () => 'rejected'),
      Promise.resolve('pending'),
    ]);
    expect(settled).toBe('pending');
  });

  it('honours a custom timeout', async () => {
    vi.useFakeTimers();
    h = mount({ timeout: 500 });
    const assertion = expect(h.created).rejects.toThrow(/handshake timed out/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('does not reject after INIT_ACK once the deadline passes', async () => {
    vi.useFakeTimers();
    h = mount({});
    h.emit('READY', { version: PROTOCOL_VERSION });
    h.emit('INIT_ACK');
    await expect(h.created).resolves.toBeDefined();
    // The timer must have been cleared; advancing past the deadline must not
    // turn an already-resolved handshake into an unhandled rejection.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(h.created).resolves.toBeDefined();
  });
});
