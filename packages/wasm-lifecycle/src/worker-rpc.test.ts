/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `createWorkerRpc`: the shared dead latch every worker client builds on. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerRpc, type RpcReply } from './worker-rpc.js';

type Out = { kind: 'call' | 'init'; id?: number };
type In = { kind: 'ok' | 'err' | 'ready' | 'init-failed'; id?: number; value?: unknown; message?: string };

/** A fake worker that can die: `crash`, `unreadable`, scripted replies. */
class FakeWorker {
  readonly posted: Array<{ message: Out; transfer: Transferable[] }> = [];
  terminateCalls = 0;
  refusePost: Error | null = null;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  postMessage(message: Out, transfer: Transferable[] = []): void {
    if (this.refusePost) throw this.refusePost;
    this.posted.push({ message, transfer });
  }
  terminate(): void { this.terminateCalls += 1; }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  reply(data: In): void { this.emit('message', { data }); }
  crash(message = 'out of memory'): void { this.emit('error', { message }); }
  unreadable(): void { this.emit('messageerror', {}); }
  lastId(): number {
    const id = this.posted.at(-1)?.message.id;
    if (id === undefined) throw new Error('nothing posted');
    return id;
  }
}

function decode(data: unknown): RpcReply<number> | undefined {
  const msg = data as In;
  if (msg.id === undefined) return undefined;
  if (msg.kind === 'ok') return { id: msg.id, value: msg.value };
  if (msg.kind === 'err') return { id: msg.id, error: new Error(msg.message) };
  return undefined;
}

function rpcOver(worker: FakeWorker, options: { requestTimeoutMs?: number; onRequestTimeout?: 'kill' | 'reject' } = {}) {
  return createWorkerRpc({ worker: worker as unknown as Worker, label: 'Test worker', decode, ...options });
}

const call = (id: number): Out => ({ kind: 'call', id });

afterEach(() => { vi.useRealTimers(); });

describe('createWorkerRpc: routing', () => {
  it('routes each answer to its own request, in any order, and ignores unknown ids', async () => {
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    const a = rpc.request<string>(call);
    const b = rpc.request<string>(call);
    const [idA, idB] = worker.posted.map((p) => p.message.id ?? -1);
    worker.reply({ kind: 'ok', id: 999, value: 'stray' });
    worker.reply({ kind: 'ok', id: idB, value: 'b' });
    worker.reply({ kind: 'err', id: idA, message: 'a failed' });
    await expect(b).resolves.toBe('b');
    await expect(a).rejects.toThrow('a failed');
    expect(rpc.alive).toBe(true);
  });

  it('passes the transfer list through and supports caller-chosen ids', async () => {
    const worker = new FakeWorker();
    let n = 0;
    const rpc = createWorkerRpc<string>({
      worker: worker as unknown as Worker,
      label: 'Test worker',
      nextId: () => `req-${++n}`,
      decode: (data) => {
        const msg = data as { id: string; value: unknown };
        return { id: msg.id, value: msg.value };
      },
    });
    const buffer = new ArrayBuffer(8);
    const answer = rpc.request<number>((id) => ({ id }), { transfer: [buffer] });
    expect(worker.posted[0]).toEqual({ message: { id: 'req-1' }, transfer: [buffer] });
    rpc.receive({ id: 'req-1', value: 7 });
    await expect(answer).resolves.toBe(7);
  });
});

describe('createWorkerRpc: dead latch', () => {
  it('a worker crash rejects everything pending, terminates once, and later requests reject at once', async () => {
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    const deaths: string[] = [];
    rpc.onDeath((reason) => deaths.push(reason.message));
    const a = rpc.request(call);
    const b = rpc.request(call);
    worker.crash();
    await expect(a).rejects.toThrow('Test worker failed: out of memory');
    await expect(b).rejects.toThrow('Test worker failed: out of memory');
    await expect(rpc.request(call)).rejects.toThrow('Test worker failed: out of memory');
    worker.unreadable();
    rpc.dispose();
    expect(worker.terminateCalls).toBe(1);
    expect(deaths).toEqual(['Test worker failed: out of memory']);
    expect(rpc.alive).toBe(false);
    expect(worker.listenerCount()).toBe(0);
  });

  it('an unreadable message (messageerror) is fatal', async () => {
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    const pending = rpc.request(call);
    worker.unreadable();
    await expect(pending).rejects.toThrow('Test worker sent a message that could not be read');
  });

  it('a call after dispose rejects instead of hanging, and notify is a no-op', async () => {
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    const inFlight = rpc.request(call);
    rpc.dispose();
    await expect(inFlight).rejects.toThrow('Test worker is disposed');
    await expect(rpc.request(call)).rejects.toThrow('Test worker is disposed');
    rpc.notify({ kind: 'call' });
    expect(worker.posted).toHaveLength(1);
  });

  it('an onDeath listener added after death runs at once; an unsubscribed one never runs', () => {
    const rpc = rpcOver(new FakeWorker());
    const early = vi.fn();
    rpc.onDeath(early)();
    rpc.fail(new Error('gone'));
    const late = vi.fn();
    rpc.onDeath(late);
    expect(early).not.toHaveBeenCalled();
    expect(late).toHaveBeenCalledWith(rpc.deadReason);
  });
});

describe('createWorkerRpc: post-throw cleanup', () => {
  it('a throwing post rejects that request alone and leaves no deadline to kill later', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const rpc = rpcOver(worker, { requestTimeoutMs: 1_000 });
    worker.refusePost = new Error('DataCloneError');
    await expect(rpc.request(call)).rejects.toThrow('DataCloneError');
    worker.refusePost = null;
    const next = rpc.request<string>(call);
    await vi.advanceTimersByTimeAsync(600);
    worker.reply({ kind: 'ok', id: worker.lastId(), value: 'fine' });
    await vi.advanceTimersByTimeAsync(600);
    await expect(next).resolves.toBe('fine');
    expect(rpc.alive).toBe(true);
    expect(worker.terminateCalls).toBe(0);
  });

  it('a late reply for a request whose post threw is ignored', async () => {
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    worker.refusePost = new Error('DataCloneError');
    await expect(rpc.request(call)).rejects.toThrow('DataCloneError');
    expect(rpc.receive({ kind: 'ok', id: 1, value: 'late' })).toBe(false);
    expect(rpc.alive).toBe(true);
  });
});

describe('createWorkerRpc: deadlines', () => {
  it("'kill': a missed request deadline kills the endpoint and rejects everything in flight", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const rpc = rpcOver(worker, { requestTimeoutMs: 1_000 });
    const slow = rpc.request(call);
    const other = rpc.request(call);
    const settled = Promise.allSettled([slow, other]);
    await vi.advanceTimersByTimeAsync(1_000);
    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(String((results[0] as PromiseRejectedResult).reason)).toContain('Test worker did not answer within 1000 ms');
    expect(worker.terminateCalls).toBe(1);
  });

  it("'reject': a missed deadline rejects only the late request, with its own error", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const rpc = rpcOver(worker, { requestTimeoutMs: 1_000, onRequestTimeout: 'reject' });
    const slow = rpc.request(call, { timeoutError: () => new Error('slow timed out') });
    const slowId = worker.lastId();
    const fast = rpc.request<string>(call, { timeoutMs: 5_000 });
    const fastId = worker.lastId();
    const slowSettled = expect(slow).rejects.toThrow('slow timed out');
    await vi.advanceTimersByTimeAsync(1_000);
    await slowSettled;
    expect(rpc.receive({ kind: 'ok', id: slowId, value: 'late' })).toBe(false);
    worker.reply({ kind: 'ok', id: fastId, value: 'fast' });
    await expect(fast).resolves.toBe('fast');
    expect(rpc.alive).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('a %s ms deadline means none', async (ms) => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const rpc = rpcOver(worker, { requestTimeoutMs: ms });
    const pending = rpc.request<string>(call);
    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(rpc.alive).toBe(true);
    worker.reply({ kind: 'ok', id: worker.lastId(), value: 'eventually' });
    await expect(pending).resolves.toBe('eventually');
  });

  it('a deadline past 2^31-1 ms is clamped, not fired after 1 ms', async () => {
    vi.useFakeTimers();
    const rpc = rpcOver(new FakeWorker(), { requestTimeoutMs: 2 ** 40 });
    void rpc.request(call).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(rpc.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(rpc.alive).toBe(false);
  });
});

describe('createWorkerRpc: abort', () => {
  it('an aborted request rejects, drops its entry, runs onAbort, and its late answer is ignored', async () => {
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    const controller = new AbortController();
    const aborted: number[] = [];
    const pending = rpc.request(call, {
      signal: controller.signal,
      onAbort: (id) => aborted.push(id),
      abortError: () => new Error('cancelled'),
    });
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(aborted).toEqual([worker.lastId()]);
    expect(rpc.receive({ kind: 'ok', id: worker.lastId(), value: 'late' })).toBe(false);
  });

  it('an already-aborted signal posts nothing', async () => {
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    const pending = rpc.request(call, { signal: AbortSignal.abort() });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.posted).toHaveLength(0);
  });
});

describe('createWorkerRpc: start', () => {
  const accept = (data: unknown) => {
    const msg = data as In;
    if (msg.kind === 'ready') return { ready: msg.value };
    if (msg.kind === 'init-failed') return { error: new Error(`init: ${msg.message}`) };
    return undefined;
  };
  const startOver = (worker: FakeWorker, rpc: ReturnType<typeof rpcOver>, timeoutMs = 1_000) =>
    rpc.start({ post: () => worker.postMessage({ kind: 'init' }), accept, timeoutMs });

  it('resolves with the ready payload, disarms the start deadline, and later traffic flows to requests', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    const started = startOver(worker, rpc);
    worker.reply({ kind: 'ready', value: 'engine-1' });
    await expect(started).resolves.toBe('engine-1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc.alive).toBe(true);
    const pending = rpc.request<string>(call);
    worker.reply({ kind: 'ok', id: worker.lastId(), value: 'x' });
    await expect(pending).resolves.toBe('x');
  });

  it('an init error, a crash, an unreadable message or a throwing post each reject start and kill the worker', async () => {
    const cases: Array<[string, (worker: FakeWorker) => void, string]> = [
      ['init error', (w) => w.reply({ kind: 'init-failed', message: 'no wasm' }), 'init: no wasm'],
      ['crash', (w) => w.crash('boom'), 'Test worker failed: boom'],
      ['unreadable', (w) => w.unreadable(), 'could not be read'],
    ];
    for (const [, trigger, message] of cases) {
      const worker = new FakeWorker();
      const rpc = rpcOver(worker);
      const started = startOver(worker, rpc);
      trigger(worker);
      await expect(started).rejects.toThrow(message);
      expect(worker.terminateCalls).toBe(1);
    }
    const worker = new FakeWorker();
    worker.refusePost = new Error('DataCloneError');
    const rpc = rpcOver(worker);
    await expect(startOver(worker, rpc)).rejects.toThrow('DataCloneError');
    expect(worker.terminateCalls).toBe(1);
  });

  it('a silent worker rejects start at its own deadline; a later error does not reject twice', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const rpc = rpcOver(worker, { requestTimeoutMs: 10 });
    const started = startOver(worker, rpc, 5_000);
    const settled = expect(started).rejects.toThrow('Test worker did not start within 5000 ms');
    // The short request deadline does not apply to start.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(rpc.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    worker.crash();
    expect(worker.terminateCalls).toBe(1);
    expect(rpc.deadReason?.message).toContain('did not start');
  });

  it('start on a dead endpoint rejects at once and posts nothing', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    rpc.dispose();
    await expect(startOver(worker, rpc)).rejects.toThrow('Test worker is disposed');
    expect(worker.posted).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a second start while one runs rejects without disturbing the first', async () => {
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    const first = startOver(worker, rpc);
    await expect(startOver(worker, rpc)).rejects.toThrow('Test worker is already starting');
    worker.reply({ kind: 'ready', value: 'one' });
    await expect(first).resolves.toBe('one');
    expect(worker.posted).toHaveLength(1);
  });

  it('a crash during start clears the start deadline', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const rpc = rpcOver(worker);
    const started = startOver(worker, rpc, 5_000);
    worker.crash();
    await expect(started).rejects.toThrow('failed');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createWorkerRpc: port mode', () => {
  it('feeds replies through receive() and closes the transport on death', async () => {
    const sent: unknown[] = [];
    const close = vi.fn();
    const rpc = createWorkerRpc({ label: 'Port', post: (m) => sent.push(m), close, decode });
    const pending = rpc.request<string>(call);
    expect(rpc.receive({ kind: 'ok', id: 1, value: 'via port' })).toBe(true);
    await expect(pending).resolves.toBe('via port');
    rpc.dispose(new Error('Port closed'));
    rpc.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(rpc.request(call)).rejects.toThrow('Port closed');
    expect(sent).toHaveLength(1);
  });
});
