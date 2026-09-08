/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Blob GC lifecycle and configuration policy.
 *
 * Split from `blob-gc.ts`, which had grown past this repo's ~400-line limit by
 * carrying two separable concerns: WHAT to collect (reference scanning,
 * planning, deletion - still there) and WHEN and WHETHER to run
 * (scheduling, environment parsing, safety bounds - here).
 *
 * The seam is worth having beyond the line count: everything here is policy an
 * operator can get wrong, and it is where the two #2804 defects lived - a
 * schedule that never fired at boot, and a grace floor set at the destructive
 * value.
 */

import * as path from 'node:path';
import {
  DEFAULT_BLOB_GC_GRACE_MS,
  applyBlobGc,
  collectLiveBlobRefs,
  collectPersistedBlobRefs,
  planBlobGc,
  type BlobGcResult,
  type GcBlobStorage,
} from './blob-gc.js';
import { defaultMetrics } from './metrics.js';
import type { RoomManager } from './room-manager.js';

/**
 * Smallest grace window an operator may configure.
 *
 * Zero used to be legal, and zero is the destructive value: it makes `cutoff`
 * equal to `now`, so EVERY unreferenced blob is condemned regardless of age,
 * including one uploaded milliseconds earlier by an in-flight share whose doc
 * reference has not landed yet. The grace window exists precisely to cover that
 * PUT-then-reference gap, so allowing it to be switched off defeats the only
 * protection the sweep has.
 *
 * A minute is far above the real race (a single HTTP round trip) while still
 * letting an operator sweep aggressively. The bound belongs where the behaviour
 * stops being safe, not where the type stops being valid; tests that need a
 * tighter window pass `graceMs` to the worker directly rather than through the
 * environment.
 */
const MIN_BLOB_GC_GRACE_MS = 60_000;


/**
 * Largest delay `setInterval` accepts (2^31 - 1 ms, about 24.8 days).
 *
 * Node clamps anything ABOVE this to 1ms, exactly as it does for NaN and for
 * values below 1. So an over-large interval is not "sweeps rarely", it is
 * "sweeps a thousand times a second" - the same flood as a zero, reached from
 * the opposite direction. Rejected rather than clamped, since a number that
 * large is a mistake either way.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;


export interface BlobGcWorkerOptions {
  readonly dataDir: string;
  readonly storage: GcBlobStorage;
  readonly roomManager?: RoomManager;
  readonly intervalMs?: number;
  readonly graceMs?: number;
  readonly now?: () => number;
  /** Counters so a permanently failing sweep is visible on `/metrics`. */
  readonly counters?: { sweep?: () => void; failure?: () => void; deleted?: (n: number) => void };
}

/**
 * Periodic blob sweep. Mirrors `SnapshotWorker`: unref'd timer, one sweep in
 * flight at a time, failures logged rather than thrown at the timer.
 *
 * Every sweep logs a line, INCLUDING zero-delete sweeps. A GC that silently
 * stops running is the same defect class as the one that caused #2790, so the
 * healthy case has to be visible too, and failures increment a counter.
 */
export class BlobGcWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<BlobGcResult> | null = null;
  private readonly opts: BlobGcWorkerOptions;

  constructor(opts: BlobGcWorkerOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.timer) return;
    // Sweep once at boot, BEFORE arming the interval. `setInterval` does not
    // fire immediately, so with the default 6h period a process that restarts
    // more often than that never completes a sweep at all: the GC is present
    // in the code and absent in effect, and the volume fills exactly as in
    // #2790. Hosted deploys restart on redeploy, OOM and platform events, so
    // this is the normal case rather than an edge one.
    //
    // It is deliberately not awaited: startup must not block on a disk scan,
    // and a failure here is counted and logged like any other sweep.
    void this.runOnce().catch((err) => {
      this.opts.counters?.failure?.();
      // eslint-disable-next-line no-console
      console.error('[blob-gc] initial sweep failed:', err);
    });
    this.timer = setInterval(
      () => {
        void this.runOnce().catch((err) => {
          this.opts.counters?.failure?.();
          // eslint-disable-next-line no-console
          console.error('[blob-gc] sweep failed:', err);
        });
      },
      this.opts.intervalMs ?? 6 * 60 * 60 * 1000,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<BlobGcResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.sweep().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async sweep(): Promise<BlobGcResult> {
    const now = this.opts.now?.() ?? Date.now();
    const graceMs = this.opts.graceMs ?? DEFAULT_BLOB_GC_GRACE_MS;

    // Live scan first: see the module note on the unload race.
    const live = await collectLiveBlobRefs(this.opts.roomManager);
    const persisted = await collectPersistedBlobRefs(this.opts.dataDir);
    const referenced = new Set<string>([...live, ...persisted.refs]);

    const plan = await planBlobGc({
      blobsDir: path.join(this.opts.dataDir, 'blobs'),
      referenced,
      roomLogs: persisted.roomLogs,
      graceMs,
      now,
    });
    // Re-check live references immediately before deleting. Between the scan
    // and this point a LOADED room can gain a reference to an already-old blob
    // through an ordinary CRDT update, and the per-hash lock only serialises
    // against PUTs, not against doc writes. Re-reading the in-memory rooms is
    // cheap and closes that window for every room the server has loaded.
    //
    // It does NOT make the race impossible: a reference landing between this
    // check and the unlink still loses. It is narrow in practice because the
    // client always re-PUTs a blob before referencing it (`HttpBlobStore.put`
    // has no dedupe), which refreshes mtime and takes the lock, and because a
    // fork copies references out of a room that already holds them, so those
    // blobs were never candidates.
    const recheck = await collectLiveBlobRefs(this.opts.roomManager);
    const safe = plan.deleteHashes.filter((h) => !recheck.has(h));
    const skipped = plan.deleteHashes.length - safe.length;
    if (skipped > 0) {
      // eslint-disable-next-line no-console
      console.log(`[blob-gc] ${skipped} blob(s) became referenced mid-sweep; keeping them`);
    }
    const result = await applyBlobGc(this.opts.storage, { ...plan, deleteHashes: safe }, now - graceMs);

    this.opts.counters?.sweep?.();
    if (result.deletedBlobs > 0) this.opts.counters?.deleted?.(result.deletedBlobs);
    // eslint-disable-next-line no-console
    console.log(
      `[blob-gc] swept ${plan.roomLogs} room log(s): deleted ${result.deletedBlobs} blob(s), ` +
        `${result.deletedTmp} stale upload(s), kept ${result.kept}`,
    );
    return result;
  }
}

/**
 * Resolve blob-GC settings from the environment.
 *
 * Exported, and `main` calls it, specifically so the wiring can be tested. A
 * test that constructs its own worker would pass with this wiring deleted,
 * which is the failure mode that let #2790 happen: a sweep that silently never
 * runs looks exactly like a sweep with nothing to do.
 */
export function resolveBlobGcConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  intervalMs: number;
  graceMs: number;
} {
  const flag = env.COLLAB_BLOB_GC;
  return {
    // Default ON. Blobs are never otherwise deleted, so an operator who does
    // nothing must still be protected from the inode exhaustion in #2790.
    enabled: flag !== '0' && flag !== 'false',
    intervalMs: duration(
      env.COLLAB_BLOB_GC_INTERVAL_MS,
      6 * 60 * 60 * 1000,
      'COLLAB_BLOB_GC_INTERVAL_MS',
      1,
      MAX_TIMER_DELAY_MS,
    ),
    graceMs: duration(
      env.COLLAB_BLOB_GC_GRACE_MS,
      DEFAULT_BLOB_GC_GRACE_MS,
      'COLLAB_BLOB_GC_GRACE_MS',
      MIN_BLOB_GC_GRACE_MS,
    ),
  };
}

/**
 * Parse a duration env var, rejecting anything not finite and in range.
 *
 * A bare `Number()` here is a data-loss bug, not a style issue: `Number('')`
 * and `Number('abc')` give 0 and NaN. A NaN grace makes `cutoff` NaN, and
 * `stat.mtimeMs >= NaN` is FALSE, so `planBlobGc` falls through and condemns
 * EVERY unreferenced blob regardless of age, destroying the race protection.
 * A NaN or zero interval makes `setInterval` fire about every millisecond.
 * Fail loudly at startup instead: a misconfigured sweep must not run at all.
 */
function duration(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(
      `[blob-gc] ${name}=${JSON.stringify(raw)} is not a finite number in [${min}, ${max}]; refusing to start`,
    );
  }
  return n;
}

/** Arm the periodic blob sweep, or return null when disabled. */
export function startBlobGc(deps: {
  dataDir: string;
  storage: GcBlobStorage;
  roomManager?: RoomManager;
  config: ReturnType<typeof resolveBlobGcConfig>;
  /** Forwarded so a permanently failing sweep is visible on `/metrics`. */
  counters?: BlobGcWorkerOptions['counters'];
}): BlobGcWorker | null {
  if (!deps.config.enabled) return null;
  // Default the counters onto the package metrics singleton, which is what
  // `startCollabServer` publishes at `/metrics`. Without this the "a failing
  // sweep is visible" claim above is false: `bin.ts` is the only production
  // construction path and a failing sweep would produce console output only.
  const sweeps = defaultMetrics.counter('collab_blob_gc_sweeps_total', 'Blob GC sweeps completed');
  const failures = defaultMetrics.counter('collab_blob_gc_failures_total', 'Blob GC sweeps that threw');
  const removed = defaultMetrics.counter('collab_blob_gc_deleted_total', 'Blobs deleted by GC');
  const worker = new BlobGcWorker({
    dataDir: deps.dataDir,
    storage: deps.storage,
    roomManager: deps.roomManager,
    intervalMs: deps.config.intervalMs,
    graceMs: deps.config.graceMs,
    counters: deps.counters ?? {
      sweep: () => sweeps.inc(),
      failure: () => failures.inc(),
      deleted: (n) => removed.inc(n),
    },
  });
  worker.start();
  return worker;
}
