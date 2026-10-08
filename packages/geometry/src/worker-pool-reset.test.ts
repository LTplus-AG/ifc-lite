/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, vi } from 'vitest';
import { GeometryWorkerPool } from './geometry-worker-pool.js';

const MB = 1024 * 1024;
/** Controllable transport: acknowledgement is withheld while the previous callback is running. */
class ResetTransport {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  token = 0;
  terminated = false;
  postMessage(data: { type?: string; token?: number }): void {
    if (data.type === 'pool-reset') this.token = data.token ?? 0;
  }
  terminate(): void { this.terminated = true; }
  reply(heap: unknown, token = this.token): void {
    this.onmessage?.call(this as unknown as Worker,
      { data: { type: 'pool-reset-done', token, wasmHeapBytes: heap } } as MessageEvent);
  }
}
afterEach(() => vi.useRealTimers());

it('#7036 holds a completed callback worker outside the idle pool until the matching reset acknowledgement', async () => {
  const transport = new ResetTransport();
  const pool = new GeometryWorkerPool({ spawn: () => transport as unknown as Worker });
  const lease = pool.acquire('prepass', 'binary');
  const returned = pool.release(lease.worker);
  expect(pool.stats().idle).toBe(0);
  transport.reply(20 * MB, transport.token + 1);
  expect(pool.stats().idle).toBe(0);
  transport.reply(20 * MB);
  expect(await returned).toBe(true);
  expect(pool.stats().idleBytes).toBe(27 * MB);
  expect(pool.acquire('geometry', 'binary').worker).toBe(lease.worker);
});

it('#7036 times out a reset and never reuses a late acknowledgement', async () => {
  vi.useFakeTimers();
  const transport = new ResetTransport();
  const pool = new GeometryWorkerPool({ spawn: () => transport as unknown as Worker, limits: { resetTimeoutMs: 10 } });
  const returned = pool.release(pool.acquire('geometry', '').worker);
  await vi.advanceTimersByTimeAsync(10);
  expect(await returned).toBe(false);
  expect(transport.terminated).toBe(true);
  transport.reply(20 * MB);
  expect(pool.stats().idle).toBe(0);
});

it('#7036 drain invalidates a reset in progress even if its acknowledgement later arrives', async () => {
  const transport = new ResetTransport();
  const pool = new GeometryWorkerPool({ spawn: () => transport as unknown as Worker });
  const returned = pool.release(pool.acquire('geometry', '').worker);
  pool.drain('memory-pressure');
  transport.reply(20 * MB);
  expect(await returned).toBe(false);
  expect(transport.terminated).toBe(true);
  expect(pool.stats().idle).toBe(0);
});

it('#7036 returned heap reservations enforce the aggregate ceiling', async () => {
  const transports: ResetTransport[] = [];
  const pool = new GeometryWorkerPool({ spawn: () => {
    const transport = new ResetTransport(); transports.push(transport); return transport as unknown as Worker;
  }, limits: { idleBytesCeiling: 40 * MB } });
  const workers = [pool.acquire('geometry', ''), pool.acquire('prepass', '')];
  const returns = workers.map(lease => pool.release(lease.worker));
  for (const transport of transports) transport.reply(20 * MB);
  expect(await Promise.all(returns)).toEqual([true, false]);
  expect(pool.stats().idleBytes).toBe(27 * MB);
  expect(transports[1].terminated).toBe(true);
  pool.drain();
});

// Drain does not cancel an active load; it also must not let that load refill the idle pool afterward.
it('#7036 memory pressure retires a lease acquired before the drain', async () => {
  const transport = new ResetTransport();
  const pool = new GeometryWorkerPool({ spawn: () => transport as unknown as Worker });
  const lease = pool.acquire('geometry', '');
  pool.drain('memory-pressure');
  const returned = pool.release(lease.worker);
  transport.reply(20 * MB);
  expect(await returned).toBe(false);
  expect(transport.terminated).toBe(true);
  expect(pool.stats().idle).toBe(0);
});

it('#7036 cancellation interrupts the return handshake and terminates its worker', async () => {
  const transport = new ResetTransport();
  const pool = new GeometryWorkerPool({ spawn: () => transport as unknown as Worker });
  const controller = new AbortController();
  const returned = pool.release(pool.acquire('geometry', '').worker, controller.signal);
  controller.abort();
  expect(await returned).toBe(false);
  expect(transport.terminated).toBe(true);
  transport.reply(20 * MB);
  expect(pool.stats().idle).toBe(0);
});

it('#7036 a host already hidden before boot admits no prewarmed instances', () => {
  let created = 0;
  const pool = new GeometryWorkerPool({ canRetain: () => false, spawn: () => {
    created++; return new ResetTransport() as unknown as Worker;
  } });
  expect(pool.prewarm(2, '', () => {})).toBe(0);
  expect(created).toBe(0);
  expect(pool.stats().idle).toBe(0);
});

it('#7036 boot workers become idle only after measured initialization readiness', () => {
  const transport = new ResetTransport();
  const pool = new GeometryWorkerPool({ spawn: () => transport as unknown as Worker });
  expect(pool.prewarm(1, '', () => {})).toBe(1);
  expect(pool.stats().idle).toBe(0);
  expect(pool.stats().prewarmed).toBe(0);
  expect(pool.prewarm(1, '', () => {})).toBe(0);
  transport.onmessage?.call(transport as unknown as Worker,
    { data: { type: 'ready', wasmHeapBytes: 9 * MB } } as MessageEvent);
  expect(pool.stats().idle).toBe(1);
  expect(pool.stats().idleBytes).toBe(16 * MB);
  expect(pool.stats().prewarmed).toBe(1);
});

it('#7036 a load takes an initializing worker without creating or initializing a second instance', () => {
  const transport = new ResetTransport();
  const pool = new GeometryWorkerPool({ spawn: () => transport as unknown as Worker });
  let initCalls = 0;
  pool.prewarm(1, '', () => { initCalls++; });
  const lease = pool.acquire('prepass', '');
  expect(lease.worker).toBe(transport);
  expect(lease.prewarmed).toBe(false);
  expect(lease.initializationQueued).toBe(true);
  expect(initCalls).toBe(1);
  expect(pool.stats().spawned).toBe(1);
  expect(pool.stats().idle).toBe(0);
  expect(transport.onmessage).toBeNull();
});

it('#7036 unmeasured and oversized initialization heaps never enter idle retention', () => {
  for (const heap of [undefined, 0, 65 * MB]) {
    const transport = new ResetTransport();
    const pool = new GeometryWorkerPool({ spawn: () => transport as unknown as Worker });
    pool.prewarm(1, '', () => {});
    transport.onmessage?.call(transport as unknown as Worker,
      { data: { type: 'ready', wasmHeapBytes: heap } } as MessageEvent);
    expect(pool.stats().idle).toBe(0);
    expect(transport.terminated).toBe(true);
  }
});

it('#7036 hidden admission and memory-pressure drain invalidate delayed boot readiness', () => {
  let visible = true;
  const transport = new ResetTransport();
  const pool = new GeometryWorkerPool({ spawn: () => transport as unknown as Worker, canRetain: () => visible });
  pool.prewarm(1, '', () => {});
  visible = false;
  transport.onmessage?.call(transport as unknown as Worker,
    { data: { type: 'ready', wasmHeapBytes: 9 * MB } } as MessageEvent);
  expect(transport.terminated).toBe(true);
  expect(pool.stats().idle).toBe(0);
  visible = true;
  pool.prewarm(1, '', () => {});
  const lateReady = transport.onmessage;
  pool.drain('memory-pressure');
  lateReady?.call(transport as unknown as Worker,
    { data: { type: 'ready', wasmHeapBytes: 9 * MB } } as MessageEvent);
  expect(pool.stats().idle).toBe(0);
});

it('#7036 failed or expired initializations terminate without becoming idle', async () => {
  vi.useFakeTimers();
  const failed = new ResetTransport();
  const expired = new ResetTransport();
  let next = failed;
  const pool = new GeometryWorkerPool({ spawn: () => next as unknown as Worker, limits: { idleReleaseMs: 10 } });
  pool.prewarm(1, '', () => {});
  failed.onmessage?.call(failed as unknown as Worker, { data: { type: 'error', message: 'initialization failed' } } as MessageEvent);
  expect(failed.terminated).toBe(true);
  expect(pool.stats().idle).toBe(0);
  next = expired;
  pool.prewarm(1, '', () => {});
  const late = expired.onmessage;
  await vi.advanceTimersByTimeAsync(10);
  expect(expired.terminated).toBe(true);
  expect(expired.onmessage).toBeNull();
  late?.call(expired as unknown as Worker, { data: { type: 'ready', wasmHeapBytes: 9 * MB } } as MessageEvent);
  expect(pool.stats().idle).toBe(0);
});

it('#7036 boot acknowledgements obey the aggregate measured heap budget', () => {
  const workers: ResetTransport[] = [];
  const pool = new GeometryWorkerPool({ spawn: () => {
    const worker = new ResetTransport(); workers.push(worker); return worker as unknown as Worker;
  }, limits: { idleBytesCeiling: 40 * MB } });
  expect(pool.prewarm(2, '', () => {})).toBe(2);
  for (const worker of workers) worker.onmessage?.call(worker as unknown as Worker,
    { data: { type: 'ready', wasmHeapBytes: 20 * MB } } as MessageEvent);
  expect(pool.stats().idle).toBe(1);
  expect(pool.stats().idleBytes).toBe(27 * MB);
  expect(workers[0].terminated).toBe(true);
});

it('#7036 delayed boot reservations remain inside admission byte and count limits', async () => {
  const workers: ResetTransport[] = [];
  const pool = new GeometryWorkerPool({ spawn: () => {
    const worker = new ResetTransport(); workers.push(worker); return worker as unknown as Worker;
  }, limits: { maxIdle: 2, idleBytesCeiling: 32 * MB } });
  pool.prewarm(2, '', () => {});
  workers[0].onmessage?.call(workers[0] as unknown as Worker,
    { data: { type: 'ready', wasmHeapBytes: 20 * MB } } as MessageEvent);
  // 27 MiB measured booking plus the still-initializing 16 MiB would exceed 32.
  expect(workers[0].terminated).toBe(true);
  expect(pool.stats().idleBytes + pool.stats().warmingReservedBytes).toBeLessThanOrEqual(32 * MB);
  const active = pool.acquire('geometry', '');
  // Acquiring the remaining initialization transfers its reservation to active ownership.
  expect(active.initializationQueued).toBe(true);
  pool.prewarm(2, '', () => {});
  const returned = pool.release(active.worker);
  (active.worker as unknown as ResetTransport).reply(9 * MB);
  expect(await returned).toBe(false); // both capacity slots are already reserved by boot workers
  expect(pool.stats().idle + pool.stats().warming).toBe(2);
  expect(pool.stats().idleBytes + pool.stats().warmingReservedBytes).toBeLessThanOrEqual(32 * MB);
  pool.drain('witness-end');
});
