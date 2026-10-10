/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded idle instances. Used workers return only after a serialized reset acknowledgement (#7036). */

import { resetGeometryWorker } from './worker-pool-reset.js';
import { accountWorkerMessages, perfCount } from '@ifc-lite/load-trace';

/** The one construction site of the geometry worker bundle (Vite rewrites this URL). */
export function spawnGeometryWorker(): Worker {
  return new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
}

export type PoolWorkerRole = 'geometry' | 'prepass';

export interface GeometryWorkerPoolLimits {
  /** Idle workers kept at most (geometry and pre-pass roles share the pool). */
  maxIdle: number;
  /** Measured idle bookings plus initializing-worker reservations kept at most. */
  idleBytesCeiling: number;
  /** Terminate every idle worker after this long without a lease. */
  idleReleaseMs: number;
  /** Recycle grown WASM instances instead of retaining their non-shrinking heaps. */
  maxWorkerHeapBytes: number;
  /** A reset that does not settle promptly is a failed worker. */
  resetTimeoutMs: number;
}

const MB = 1024 * 1024;

/** Initial reservation: the pinned engine starts below 9 MiB; worker overhead is estimated at 7 MiB. */
export const FRESH_WORKER_HEAP_BYTES = 16 * MB;

export const DEFAULT_POOL_LIMITS: GeometryWorkerPoolLimits = {
  // The 8-worker hard cap of `computeWorkerCount` plus the pre-pass worker.
  maxIdle: 9,
  idleBytesCeiling: 9 * FRESH_WORKER_HEAP_BYTES,
  idleReleaseMs: 60_000,
  maxWorkerHeapBytes: 64 * MB,
  resetTimeoutMs: 1_000,
};

export interface PoolLease {
  readonly worker: Worker;
  /** True when the engine is already initialized (prewarmed or successfully reset). */
  readonly prewarmed: boolean;
  /** The pending boot init precedes this lease on the worker FIFO. */
  readonly initializationQueued: boolean;
}

export interface GeometryWorkerPoolStats {
  idle: number;
  idleBytes: number;
  /** Initializing instances, excluded from idle until measured readiness. */
  warming: number;
  warmingReservedBytes: number;
  spawned: number;
  prewarmed: number;
  leasedWarm: number;
  drained: number;
}

interface IdleWorker { worker: Worker; key: string; bytes: number; used: boolean }

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
  private readonly warming = new Map<Worker, { key: string; timer: unknown }>();
  private readonly leases = new WeakMap<Worker, { key: string; generation: number }>();
  private readonly pending = new Set<Worker>();
  private generation = 0;
  private readonly roles = new WeakMap<Worker, PoolWorkerRole>();
  private readonly limits: GeometryWorkerPoolLimits;
  private readonly spawn: () => Worker;
  private readonly timers: Timers;
  private readonly canRetain: () => boolean;
  private idleTimer: unknown = null;
  private counts = { spawned: 0, prewarmed: 0, leasedWarm: 0, drained: 0 };

  constructor(options: { spawn?: () => Worker; limits?: Partial<GeometryWorkerPoolLimits>; timers?: Timers; canRetain?: () => boolean } = {}) {
    this.spawn = options.spawn ?? spawnGeometryWorker;
    this.limits = { ...DEFAULT_POOL_LIMITS, ...options.limits };
    this.timers = options.timers ?? defaultTimers;
    this.canRetain = options.canRetain ?? (() => true);
  }

  /**
   * Lease a worker for `role`: a prewarmed one for the same engine binary
   * (`key`) when idle, else a fresh spawn. Idle workers for a different binary
   * are terminated, since they cannot serve this engine. A successful load
   * returns its lease through release(); every failure terminates it.
   */
  acquire(role: PoolWorkerRole, key: string): PoolLease {
    this.dropForeignKeys(key);
    const entry = this.idle.shift();
    const boot = entry ? undefined : this.warming.entries().next().value;
    if (boot) this.detachWarming(boot[0]);
    if (this.idle.length === 0) this.clearIdleTimer();
    let worker: Worker;
    if (entry) {
      worker = entry.worker;
      worker.onmessage = null; worker.onerror = null;
      this.counts.leasedWarm++;
      perfCount(entry.used ? 'worker.reused' : 'worker.prewarmed');
    } else if (boot) {
      worker = boot[0];
    } else {
      worker = this.create();
      perfCount('worker.spawned');
    }
    this.roles.set(worker, role);
    this.leases.set(worker, { key, generation: this.generation });
    return { worker, prewarmed: entry !== undefined, initializationQueued: boot !== undefined };
  }

  /**
   * Start workers until `count` are ready or initializing for `key`.
   * Only measured init acknowledgements admit idle workers. A load can take an
   * initializing worker exclusively; its queued init precedes the load on FIFO.
   * Returns how many were started, not how many have become ready.
   */
  prewarm(count: number, key: string, init: (worker: Worker) => void): number {
    if (!this.canRetain()) { this.drain('retention-disabled'); return 0; }
    this.dropForeignKeys(key);
    const target = Math.min(count, this.limits.maxIdle);
    let started = 0;
    while (this.idle.length + this.warming.size < target
      && this.idleBytes() + (this.warming.size + 1) * FRESH_WORKER_HEAP_BYTES <= this.limits.idleBytesCeiling) {
      const worker = this.create();
      const timer = this.timers.setTimeout(() => this.remove(worker, 'init-timeout'), this.limits.idleReleaseMs);
      this.warming.set(worker, { key, timer });
      worker.onerror = () => this.remove(worker, 'init-error');
      worker.onmessage = ({ data }: MessageEvent<{ type?: string; wasmHeapBytes?: number }>) => {
        if (!this.warming.has(worker)) return;
        if (data.type === 'error') { this.remove(worker, 'init-error'); return; }
        if (data.type !== 'ready') return;
        this.detachWarming(worker);
        if (!this.admit(worker, key, data.wasmHeapBytes, false)) {
          this.terminate(worker, 'init-budget'); return;
        }
        this.counts.prewarmed++;
      };
      try { init(worker); }
      catch (err) {
        console.warn('[pool] prewarm init failed; terminating the worker:', err);
        this.remove(worker, 'prewarm-init'); break;
      }
      started++;
    }
    return started;
  }

  /** Reset after a successful load; no worker becomes leaseable before its acknowledgement. */
  async release(worker: Worker, signal?: AbortSignal): Promise<boolean> {
    const lease = this.leases.get(worker);
    if (lease === undefined) return false;
    const { key, generation } = lease;
    this.leases.delete(worker);
    this.pending.add(worker);
    const heap = await resetGeometryWorker(worker, this.limits.resetTimeoutMs, signal);
    this.pending.delete(worker);
    if (signal?.aborted || generation !== this.generation || !this.admit(worker, key, heap, true)) {
      perfCount('worker.recycled');
      this.terminate(worker, 'reset-or-budget');
      return false;
    }
    return true;
  }

  /** Terminate every idle worker (memory pressure, a hidden tab, a large load, long idle). */
  drain(reason = 'drain'): number {
    this.generation++;
    for (const worker of this.warming.keys()) this.remove(worker, reason);
    for (const worker of this.pending) this.terminate(worker, reason);
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
    return { idle: this.idle.length, idleBytes: this.idleBytes(), warming: this.warming.size,
      warmingReservedBytes: this.warming.size * FRESH_WORKER_HEAP_BYTES, ...this.counts };
  }

  /** Both boot-ready and reset-ready workers satisfy the same measured idle contract. */
  private admit(worker: Worker, key: string, heap: unknown, used: boolean): boolean {
    if (!this.canRetain() || typeof heap !== 'number' || !Number.isSafeInteger(heap) || heap <= 0
      || heap > this.limits.maxWorkerHeapBytes || this.idle.length + this.warming.size >= this.limits.maxIdle) return false;
    const bytes = heap + (FRESH_WORKER_HEAP_BYTES - 9 * MB);
    if (this.idleBytes() + bytes + this.warming.size * FRESH_WORKER_HEAP_BYTES > this.limits.idleBytesCeiling) return false;
    worker.onmessage = ({ data }: MessageEvent<{ type?: string }>) => {
      if (data.type === 'error') this.remove(worker, 'idle-error');
    };
    worker.onerror = () => this.remove(worker, 'idle-error');
    this.idle.push({ worker, key, bytes, used });
    if (this.idleTimer === null) this.armIdleTimer();
    return true;
  }

  private idleBytes(): number {
    return this.idle.reduce((total, entry) => total + entry.bytes, 0);
  }

  private create(): Worker {
    this.counts.spawned++;
    const worker = this.spawn();
    // #6957: a prewarmed worker learns its role only when leased.
    return accountWorkerMessages(worker, () => this.roleOf(worker));
  }

  private detachWarming(worker: Worker): void {
    const boot = this.warming.get(worker);
    if (boot) this.timers.clearTimeout(boot.timer);
    this.warming.delete(worker);
    worker.onmessage = null; worker.onerror = null;
  }

  private remove(worker: Worker, reason: string): void {
    if (this.warming.has(worker)) this.detachWarming(worker);
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
    for (const [worker, boot] of this.warming) {
      if (boot.key !== key) this.remove(worker, 'engine-changed');
    }
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
