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

// Implicit-state audit P4: a timed-out handshake must tear the instance down.
// Before the fix, create() rejected but left the iframe mounted, the window
// `message` listener attached and the READY handler armed, so a late READY
// still posted the bearer token into an iframe the host had given up on.
describe('handshake timeout tears the instance down (audit P4)', () => {
  it('P4: removes the iframe from the container when the handshake times out', async () => {
    vi.useFakeTimers();
    h = mount({ timeout: 500 });
    expect(h.container.querySelector('iframe')).not.toBeNull();
    const assertion = expect(h.created).rejects.toThrow(/handshake timed out/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(h.container.querySelector('iframe')).toBeNull();
  });

  it('P4: a READY arriving after the timeout does not post the bearer token', async () => {
    vi.useFakeTimers();
    h = mount({ timeout: 500, token: 'secret-bearer' });
    const assertion = expect(h.created).rejects.toThrow(/handshake timed out/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    h.emit('READY', { version: PROTOCOL_VERSION });
    expect(h.posted).toEqual([]);
  });

  it('P4: detaches the window message listener when the handshake times out', async () => {
    vi.useFakeTimers();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    try {
      h = mount({ timeout: 500 });
      const assertion = expect(h.created).rejects.toThrow(/handshake timed out/);
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
      expect(removeSpy.mock.calls.some(([type]) => type === 'message')).toBe(true);
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('P4: a host retrying into the same container after a timeout ends with one iframe, not a stack', async () => {
    vi.useFakeTimers();
    h = mount({ timeout: 500 });
    const first = expect(h.created).rejects.toThrow(/handshake timed out/);
    await vi.advanceTimersByTimeAsync(500);
    await first;
    const retry = mount({ container: h.container, timeout: 500 });
    try {
      expect(h.container.querySelectorAll('iframe')).toHaveLength(1);
      const second = expect(retry.created).rejects.toThrow(/handshake timed out/);
      await vi.advanceTimersByTimeAsync(500);
      await second;
      expect(h.container.querySelectorAll('iframe')).toHaveLength(0);
    } finally {
      retry.cleanup();
    }
  });

  it('P4: an INIT_ACK arriving after the timeout leaves create() rejected', async () => {
    vi.useFakeTimers();
    h = mount({ timeout: 500 });
    h.emit('READY', { version: PROTOCOL_VERSION });
    const assertion = expect(h.created).rejects.toThrow(/handshake timed out/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    h.emit('INIT_ACK');
    await expect(h.created).rejects.toThrow(/handshake timed out/);
  });
});
