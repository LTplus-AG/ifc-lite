/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry/pre-pass workers spawned AHEAD of the load that uses them (#7036).
 *
 * `processParallel` used to spawn N geometry workers plus a pre-pass worker
 * only once the file had been read, unwrapped and looked up in the cache, and
 * the spawn and engine instantiation then sat on the critical path in front of
 * the first pre-pass event. A host now calls `prewarm()` when a load is
 * requested, so the spawn overlaps the file read, and the load leases the
 * already-initialized workers instead of spawning.
 *
 * Deliberately NOT a pool that takes workers back. A wasm instance's memory
 * never shrinks, so a worker that meshed a model keeps that heap for as long
 * as it lives. Measured on a real GPU, retaining used workers held 100-400 MB
 * more renderer memory after the load and raised the load's peak by as much
 * (their heaps overlapped the main thread's finalize), to save the same
 * ~20-45 ms that spawning during the file read already saves. So a leased
 * worker belongs to its load and is terminated by it exactly as before, and
 * this pool only ever holds FRESH instances:
 *   - at most `maxIdle` of them, and at most `idleBytesCeiling` bytes booked at
 *     {@link FRESH_WORKER_HEAP_BYTES} each;
 *   - all terminated after `idleReleaseMs` without a lease (a load that hit
 *     the cache never used its workers), and on `drain()`.
 * Every worker is used by at most one load, so no load can ever receive
 * another load's messages through it.
 */

import { accountWorkerMessages, perfCount } from '@ifc-lite/load-trace';

/** The one construction site of the geometry worker bundle (Vite rewrites this URL). */
export function spawnGeometryWorker(): Worker {
  return new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
}

export type PoolWorkerRole = 'geometry' | 'prepass';

export interface GeometryWorkerPoolLimits {
  /** Idle workers kept at most (geometry and pre-pass roles share the pool). */
  maxIdle: number;
  /** Booked bytes of the idle workers kept at most. */
  idleBytesCeiling: number;
  /** Terminate every idle worker after this long without a lease. */
  idleReleaseMs: number;
}

const MB = 1024 * 1024;

/** What a freshly instantiated engine holds: ~9 MB of initial wasm memory plus worker overhead. */
export const FRESH_WORKER_HEAP_BYTES = 16 * MB;

export const DEFAULT_POOL_LIMITS: GeometryWorkerPoolLimits = {
  // The 8-worker hard cap of `computeWorkerCount` plus the pre-pass worker.
  maxIdle: 9,
  idleBytesCeiling: 9 * FRESH_WORKER_HEAP_BYTES,
  idleReleaseMs: 60_000,
};

export interface PoolLease {
  readonly worker: Worker;
  /** True when the worker was prewarmed (no spawn on this load's path). */
  readonly prewarmed: boolean;
}

export interface GeometryWorkerPoolStats {
  idle: number;
  idleBytes: number;
  spawned: number;
  prewarmed: number;
  leasedWarm: number;
  drained: number;
}

interface IdleWorker { worker: Worker; key: string }

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class GeometryWorkerPool {
  private readonly idle: IdleWorker[] = [];
  private readonly roles = new WeakMap<Worker, PoolWorkerRole>();
  private readonly limits: GeometryWorkerPoolLimits;
  private readonly spawn: () => Worker;
  private readonly timers: Timers;
  private idleTimer: unknown = null;
  private counts = { spawned: 0, prewarmed: 0, leasedWarm: 0, drained: 0 };

  constructor(options: { spawn?: () => Worker; limits?: Partial<GeometryWorkerPoolLimits>; timers?: Timers } = {}) {
    this.spawn = options.spawn ?? spawnGeometryWorker;
    this.limits = { ...DEFAULT_POOL_LIMITS, ...options.limits };
    this.timers = options.timers ?? defaultTimers;
  }

  /**
   * Lease a worker for `role`: a prewarmed one for the same engine binary
   * (`key`) when idle, else a fresh spawn. Idle workers for a different binary
   * are terminated, since they cannot serve this engine. The lease is the
   * load's for good: it terminates the worker when done with it.
   */
  acquire(role: PoolWorkerRole, key: string): PoolLease {
    this.dropForeignKeys(key);
    const entry = this.idle.shift();
    if (this.idle.length === 0) this.clearIdleTimer();
    let worker: Worker;
    if (entry) {
      worker = entry.worker;
      worker.onerror = null;
      this.counts.leasedWarm++;
      perfCount('worker.prewarmed');
    } else {
      worker = this.create();
      perfCount('worker.spawned');
    }
    this.roles.set(worker, role);
    return { worker, prewarmed: entry !== undefined };
  }

  /**
   * Spawn idle workers until `count` are waiting for `key`, within the limits.
   * `init` posts the engine init, so a worker is instantiated by the time a
   * load leases it. Returns how many were started.
   */
  prewarm(count: number, key: string, init: (worker: Worker) => void): number {
    this.dropForeignKeys(key);
    const target = Math.min(count, this.limits.maxIdle);
    let started = 0;
    while (this.idle.length < target && this.idleBytes() + FRESH_WORKER_HEAP_BYTES <= this.limits.idleBytesCeiling) {
      const worker = this.create();
      try {
        init(worker);
      } catch (err) {
        console.warn('[pool] prewarm init failed; terminating the worker:', err);
        this.terminate(worker, 'prewarm-init');
        break;
      }
      // An idle worker that dies just leaves the pool; its messages go nowhere.
      worker.onerror = () => this.remove(worker, 'idle-error');
      this.idle.push({ worker, key });
      this.counts.prewarmed++;
      started++;
    }
    if (this.idle.length > 0) this.armIdleTimer();
    return started;
  }

  /** Terminate every idle worker (memory pressure, a hidden tab, a large load, long idle). */
  drain(reason = 'drain'): number {
    const n = this.idle.length;
    for (const entry of this.idle.splice(0)) this.terminate(entry.worker, reason);
    this.counts.drained += n;
    this.clearIdleTimer();
    return n;
  }

  /** The role a leased worker serves (message counters are labelled by it). */
  roleOf(worker: Worker): PoolWorkerRole {
    return this.roles.get(worker) ?? 'geometry';
  }

  stats(): GeometryWorkerPoolStats {
    return { idle: this.idle.length, idleBytes: this.idleBytes(), ...this.counts };
  }

  private idleBytes(): number {
    return this.idle.length * FRESH_WORKER_HEAP_BYTES;
  }

  private create(): Worker {
    this.counts.spawned++;
    const worker = this.spawn();
    // #6957: a prewarmed worker learns its role only when leased.
    return accountWorkerMessages(worker, () => this.roleOf(worker));
  }

  private remove(worker: Worker, reason: string): void {
    const i = this.idle.findIndex((entry) => entry.worker === worker);
    if (i >= 0) this.idle.splice(i, 1);
    this.terminate(worker, reason);
  }

  private terminate(worker: Worker, reason: string): void {
    try {
      worker.terminate();
    } catch (err) {
      console.warn(`[pool] terminate (${reason}) failed:`, err);
    }
  }

  private dropForeignKeys(key: string): void {
    for (let i = this.idle.length - 1; i >= 0; i--) {
      if (this.idle[i].key !== key) this.terminate(this.idle.splice(i, 1)[0].worker, 'engine-changed');
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      this.drain('idle');
    }, this.limits.idleReleaseMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
