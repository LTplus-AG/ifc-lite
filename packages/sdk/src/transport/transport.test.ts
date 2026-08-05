/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Transport layer coverage.
 *
 * `BroadcastTransport`, `MessagePortTransport` and `RemoteBackend` are
 * all exported from the package root — `BroadcastTransport` is the one
 * the package README tells external tools to use for cross-tab access —
 * and none of the three had a test. Mutation testing showed the request
 * timeout default, the close-time rejection of in-flight requests, the
 * response-vs-event discrimination (which decides whether an *error*
 * reply resolves a caller or is silently handed to event subscribers),
 * and `RemoteBackend`'s event-type filter were all free to change.
 *
 * `BroadcastChannel` and `MessagePort` are stubbed rather than mocked
 * out of the module, so the real constructor / `postMessage` /
 * `onmessage` wiring is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BroadcastTransport } from './broadcast.js';
import { MessagePortTransport } from './message-port.js';
import { RemoteBackend } from './remote-backend.js';
import type { SdkEvent, SdkRequest, SdkResponse, Transport } from '../types.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** Minimal BroadcastChannel / MessagePort stand-in with the same surface. */
class FakeChannel {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  closed = false;

  postMessage(data: unknown): void {
    this.posted.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Simulate an inbound message from the other side. */
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }

  start(): void { /* MessagePort API parity */ }
}

const channels: FakeChannel[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  channels.length = 0;
  vi.stubGlobal('BroadcastChannel', class {
    constructor(readonly name: string) {
      const ch = new FakeChannel();
      channels.push(ch);
      // Delegate onto the fake so the transport's assignments land on it.
      return ch as unknown as BroadcastChannel;
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function request(id: string): SdkRequest {
  return { id, namespace: 'query', method: 'entities', args: [] };
}

// ---------------------------------------------------------------------------
// BroadcastTransport
// ---------------------------------------------------------------------------

describe('BroadcastTransport', () => {
  it('posts the request on the named channel', async () => {
    const t = new BroadcastTransport('ifc-lite');
    const p = t.send(request('r1'));

    expect(channels[0].posted).toEqual([request('r1')]);

    channels[0].deliver({ id: 'r1', result: ['a'] } satisfies SdkResponse);
    await expect(p).resolves.toEqual({ id: 'r1', result: ['a'] });
  });

  it('resolves the matching pending request and leaves others in flight', async () => {
    const t = new BroadcastTransport('ifc-lite');
    const p1 = t.send(request('r1'));
    const p2 = t.send(request('r2'));

    channels[0].deliver({ id: 'r2', result: 2 } satisfies SdkResponse);
    await expect(p2).resolves.toEqual({ id: 'r2', result: 2 });

    channels[0].deliver({ id: 'r1', result: 1 } satisfies SdkResponse);
    await expect(p1).resolves.toEqual({ id: 'r1', result: 1 });
  });

  // An error reply carries `error` and no `result`. It must still resolve
  // the caller's promise; treating it as an event would leave the caller
  // hanging until the timeout.
  it('resolves a pending request from an error-only response', async () => {
    const t = new BroadcastTransport('ifc-lite');
    const p = t.send(request('r1'));

    channels[0].deliver({ id: 'r1', error: { message: 'boom' } } satisfies SdkResponse);
    await expect(p).resolves.toEqual({ id: 'r1', error: { message: 'boom' } });
  });

  it('ignores a response for an id it never sent', async () => {
    const t = new BroadcastTransport('ifc-lite');
    const p = t.send(request('r1'));

    channels[0].deliver({ id: 'ghost', result: 1 } satisfies SdkResponse);
    // Still pending: the only way to observe that is to satisfy it after.
    channels[0].deliver({ id: 'r1', result: 1 } satisfies SdkResponse);
    await expect(p).resolves.toEqual({ id: 'r1', result: 1 });
  });

  it('delivers host events to every subscriber and stops on unsubscribe', () => {
    const t = new BroadcastTransport('ifc-lite');
    const a = vi.fn();
    const b = vi.fn();
    const offA = t.subscribe(a);
    t.subscribe(b);

    const ev: SdkEvent = { type: 'selection:changed', data: [1] };
    channels[0].deliver(ev);
    expect(a).toHaveBeenCalledWith(ev);
    expect(b).toHaveBeenCalledWith(ev);

    offA();
    channels[0].deliver(ev);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('does not hand a response to event subscribers', () => {
    const t = new BroadcastTransport('ifc-lite');
    const handler = vi.fn();
    t.subscribe(handler);
    void t.send(request('r1'));

    channels[0].deliver({ id: 'r1', result: 1 } satisfies SdkResponse);
    expect(handler).not.toHaveBeenCalled();
  });

  // 30s, not "some timeout": a caller that supplies no options must not
  // have its request abandoned early, and must not wait forever either.
  it('times out an unanswered request after the 30s default', async () => {
    const t = new BroadcastTransport('ifc-lite');
    const p = t.send(request('r1'));
    const assertion = expect(p).rejects.toThrow(/timed out after 30000ms/);

    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
  });

  it('honours an explicit timeoutMs', async () => {
    const t = new BroadcastTransport('ifc-lite', { timeoutMs: 50 });
    const p = t.send(request('r1'));
    const assertion = expect(p).rejects.toThrow(/timed out after 50ms/);

    await vi.advanceTimersByTimeAsync(51);
    await assertion;
  });

  // Advancing the clock past an answered request proves nothing on its
  // own: rejecting an already-resolved promise is a no-op, so deleting
  // `clearTimeout(entry.timer)` leaves this green. The timer *count* is
  // the observable — without the clear, every answered request leaves a
  // live timer holding its reject closure for the full timeout.
  it('does not time out a request that was already answered, and clears its timer', async () => {
    const t = new BroadcastTransport('ifc-lite', { timeoutMs: 50 });
    const p = t.send(request('r1'));
    expect(vi.getTimerCount()).toBe(1);

    channels[0].deliver({ id: 'r1', result: 1 } satisfies SdkResponse);
    expect(vi.getTimerCount()).toBe(0);

    await expect(p).resolves.toEqual({ id: 'r1', result: 1 });
    await vi.advanceTimersByTimeAsync(1_000); // must not throw an unhandled rejection
  });

  // Without the close-time rejection an in-flight request hangs for the
  // full timeout after the channel is already gone — and if the timer is
  // also cleared, forever.
  it('rejects in-flight requests when the transport is closed', async () => {
    const t = new BroadcastTransport('ifc-lite');
    const p = t.send(request('r1'));
    const assertion = expect(p).rejects.toThrow(/Transport closed/);

    t.close();
    await assertion;
  });

  it('closes the underlying channel and drops subscribers', () => {
    const t = new BroadcastTransport('ifc-lite');
    const handler = vi.fn();
    t.subscribe(handler);

    t.close();

    expect(channels[0].closed).toBe(true);
    channels[0].deliver({ type: 'model:loaded', data: null } satisfies SdkEvent);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MessagePortTransport
// ---------------------------------------------------------------------------

describe('MessagePortTransport', () => {
  function setup(options?: { timeoutMs?: number }) {
    const port = new FakeChannel();
    const t = new MessagePortTransport(port as unknown as MessagePort, options);
    return { t, port };
  }

  it('posts on the port and resolves the matching response', async () => {
    const { t, port } = setup();
    const p = t.send(request('r1'));

    expect(port.posted).toEqual([request('r1')]);
    port.deliver({ id: 'r1', result: 'ok' } satisfies SdkResponse);
    await expect(p).resolves.toEqual({ id: 'r1', result: 'ok' });
  });

  it('resolves a pending request from an error-only response', async () => {
    const { t, port } = setup();
    const p = t.send(request('r1'));

    port.deliver({ id: 'r1', error: { message: 'boom' } } satisfies SdkResponse);
    await expect(p).resolves.toEqual({ id: 'r1', error: { message: 'boom' } });
  });

  // Same gap as the BroadcastTransport case above: the timer count is
  // the only observable that `clearTimeout(entry.timer)` still runs.
  it('clears the request timer once the response arrives', async () => {
    const { t, port } = setup({ timeoutMs: 50 });
    const p = t.send(request('r1'));
    expect(vi.getTimerCount()).toBe(1);

    port.deliver({ id: 'r1', result: 'ok' } satisfies SdkResponse);
    expect(vi.getTimerCount()).toBe(0);

    await expect(p).resolves.toEqual({ id: 'r1', result: 'ok' });
  });

  it('routes events to subscribers, not to pending requests', () => {
    const { t, port } = setup();
    const handler = vi.fn();
    t.subscribe(handler);

    const ev: SdkEvent = { type: 'lens:changed', data: { id: 'l1' } };
    port.deliver(ev);
    expect(handler).toHaveBeenCalledWith(ev);
  });

  it('times out after the 30s default', async () => {
    const { t } = setup();
    const p = t.send(request('r1'));
    const assertion = expect(p).rejects.toThrow(/timed out after 30000ms/);

    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
  });

  it('rejects in-flight requests and closes the port on close()', async () => {
    const { t, port } = setup();
    const p = t.send(request('r1'));
    const assertion = expect(p).rejects.toThrow(/Transport closed/);

    t.close();
    await assertion;
    expect(port.closed).toBe(true);
  });

  it('ignores non-object and null messages', () => {
    const { t, port } = setup();
    const handler = vi.fn();
    t.subscribe(handler);

    port.deliver(null);
    port.deliver('hello');
    port.deliver(42);

    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RemoteBackend
// ---------------------------------------------------------------------------

describe('RemoteBackend', () => {
  function fakeTransport() {
    const handlers = new Set<(e: SdkEvent) => void>();
    const transport: Transport = {
      send: vi.fn(async () => ({ id: 'x', result: null })),
      subscribe: (h) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      close: vi.fn(),
    };
    return { transport, emit: (e: SdkEvent) => handlers.forEach((h) => h(e)) };
  }

  // Every namespace is a throwing proxy: the failure mode must be a
  // clear synchronous error naming the namespace and method, not an
  // undefined-is-not-a-function further down the call stack.
  it.each([
    'model', 'query', 'selection', 'visibility', 'viewer',
    'mutate', 'store', 'spatial', 'export', 'lens', 'files', 'schedule',
  ] as const)('throws a named error for any %s method', (ns) => {
    const { transport } = fakeTransport();
    const backend = new RemoteBackend(transport);
    const fn = (backend as unknown as Record<string, Record<string, () => unknown>>)[ns].anything;

    expect(() => fn()).toThrow(new RegExp(`Cannot call ${ns}\\.anything\\(\\) synchronously`));
  });

  // The subscribe filter is the whole contract of `BimBackend.subscribe`:
  // a handler registered for one event type must not see another.
  it('delivers only the subscribed event type', () => {
    const { transport, emit } = fakeTransport();
    const backend = new RemoteBackend(transport);
    const onSelection = vi.fn();

    backend.subscribe('selection:changed', onSelection);

    emit({ type: 'model:loaded', data: { id: 'arch' } });
    expect(onSelection).not.toHaveBeenCalled();

    emit({ type: 'selection:changed', data: [1, 2] });
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(onSelection).toHaveBeenCalledWith([1, 2]);
  });

  it('hands back an unsubscribe that stops delivery', () => {
    const { transport, emit } = fakeTransport();
    const backend = new RemoteBackend(transport);
    const handler = vi.fn();

    const off = backend.subscribe('model:loaded', handler);
    emit({ type: 'model:loaded', data: 1 });
    off();
    emit({ type: 'model:loaded', data: 2 });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
