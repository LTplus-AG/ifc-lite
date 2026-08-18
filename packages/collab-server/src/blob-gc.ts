/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Garbage collection for content-addressed blobs.
 *
 * Blobs are one file per mesh and, until this module, were NEVER deleted:
 * `retention.ts` covers room LOGS only and `bin.ts` wired no blob retention.
 * That is why production ran out of INODES rather than bytes (#2790): 305,741
 * blobs against a 5 GB volume's 305,175 inodes, with only 2.9 GB of 4.9 GB
 * used. Mean blob size is well under the 16 KB-per-inode default ratio, so
 * inodes exhaust before bytes at ANY volume size. Growing the volume buys
 * time; this is the structural fix.
 *
 * # Safety model
 *
 * Deleting a referenced blob is silent, permanent geometry loss, so the sweep
 * is built to fail CLOSED. It deletes a blob only when ALL of these hold:
 *
 *  1. No PERSISTED room log references it. Every `*.log` in the data dir is
 *     read, not just the rooms currently loaded in memory - a room that is
 *     merely idle must not have its geometry collected.
 *  2. No LOADED room references it. A room whose newest updates have not yet
 *     been compacted to disk is covered by the live scan.
 *  3. It is older than `graceMs`. Clients PUT a blob and only then write its
 *     hash into the doc (`geometry-sync.ts`), so a fresh blob is legitimately
 *     unreferenced for a moment. The grace window covers that race.
 *
 * Blobs are shared BETWEEN rooms: the same content hash is reused by any room
 * with the same mesh, and branch forks copy refs into sibling rooms without
 * re-uploading. So references are unioned across every room and a blob
 * survives if ANY room still points at it.
 *
 * # Absence must not read as success
 *
 * Every way of "seeing no references" that is not genuinely "no references"
 * aborts the whole sweep rather than deleting:
 *
 *  - an unreadable log directory, an undecodable room name, or a doc that
 *    throws on `applyUpdate`
 *  - **a non-empty log file that `FilePersistence.load` returns `null` for.**
 *    `load` does not throw on a corrupt log: an empty file, a truncated length
 *    prefix, or any garbage yielding zero complete frames all return `null`
 *    (`persistence.ts`). Treating that as "this room references nothing" would
 *    delete every blob belonging to a damaged room. A genuinely 0-byte log is
 *    the one safe case, since it cannot hide a reference.
 *  - zero room logs found while blobs exist, which is what a mispointed
 *    `dataDir` looks like.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Y from 'yjs';
import { collectReferencedBlobHashes } from '@ifc-lite/collab';
import { FilePersistence } from './persistence.js';
import { defaultMetrics } from './metrics.js';
import type { RoomManager } from './room-manager.js';

/** Match exactly 32 lowercase hex chars (the client's `fnv128` output). */
const HASH_REGEX = /^[a-f0-9]{32}$/;

/** In-flight upload leftovers: `<hash>.tmp-<uuid>`. */
const TMP_REGEX = /^[a-f0-9]{32}\.tmp-/;

/**
 * How long an unreferenced blob must sit untouched before it can be collected.
 *
 * A client PUTs every blob BEFORE writing any hash into the doc, so there is
 * always a window in which a perfectly good blob has no reference yet. 24h is
 * far beyond that window while still bounding growth. Referenced blobs are
 * immune at any age, so this only sizes the race margin, not retention.
 */
export const DEFAULT_BLOB_GC_GRACE_MS = 24 * 60 * 60 * 1000;

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

export interface BlobGcPlan {
  /** Blob hashes safe to delete. */
  readonly deleteHashes: string[];
  /** Absolute paths of stale `<hash>.tmp-*` upload leftovers. */
  readonly deleteTmpPaths: string[];
  /** Blobs kept because they are referenced or inside the grace window. */
  readonly kept: number;
  /** How many room logs contributed references (for the log line). */
  readonly roomLogs: number;
}

export interface BlobRefScan {
  readonly refs: Set<string>;
  readonly roomLogs: number;
}

/**
 * Union of blob hashes referenced by every room log persisted under `dataDir`.
 *
 * Enumerates FILES rather than asking the RoomManager, so rooms that are
 * persisted but not currently loaded are included. Throws on anything it
 * cannot read; see the module header.
 */
export async function collectPersistedBlobRefs(dataDir: string): Promise<BlobRefScan> {
  const refs = new Set<string>();
  let roomLogs = 0;

  // Mirrors the existing room-log scan in `access-control.ts`: files only, so
  // the `blobs/` and `layer-registry/` subdirectories are skipped.
  const entries = await fs.promises.readdir(dataDir, { withFileTypes: true });
  const persistence = new FilePersistence({ dataDir });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    roomLogs += 1;
    const roomId = decodeURIComponent(entry.name.slice(0, -'.log'.length));
    const update = await persistence.load(roomId);

    if (update === null) {
      // `load` returns null for corrupt logs as well as empty ones. A 0-byte
      // file cannot hide a reference; anything larger might, so refuse to
      // treat it as an empty room.
      const stat = await fs.promises.stat(path.join(dataDir, entry.name));
      if (stat.size > 0) {
        throw new Error(
          `[blob-gc] room log ${entry.name} is ${stat.size} bytes but parsed to nothing; ` +
            'refusing to sweep, since a log we cannot read may hold blob references',
        );
      }
      continue;
    }

    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, update);
      for (const hash of collectReferencedBlobHashes(doc)) refs.add(hash);
    } finally {
      doc.destroy();
    }
  }

  return { refs, roomLogs };
}

/**
 * Union of blob hashes referenced by rooms currently loaded in memory.
 *
 * Run this BEFORE the disk scan. `RoomManager.unload` removes a room from its
 * map before awaiting the compact inside `destroy()`, so a room can be briefly
 * invisible to the live scan while its final state has not yet landed on disk.
 * Scanning live-then-disk means an unload racing the sweep is most likely to be
 * caught by the disk half. The residual - references that exist ONLY in memory,
 * which needs appends to have been failing - is accepted and documented.
 */
export async function collectLiveBlobRefs(roomManager?: RoomManager): Promise<Set<string>> {
  const refs = new Set<string>();
  if (!roomManager) return refs;
  for (const roomId of roomManager.list()) {
    const pending = roomManager.peek(roomId);
    if (!pending) continue;
    const room = await pending;
    for (const hash of collectReferencedBlobHashes(room.doc)) refs.add(hash);
  }
  return refs;
}

export interface PlanBlobGcOptions {
  readonly blobsDir: string;
  readonly referenced: ReadonlySet<string>;
  readonly roomLogs: number;
  readonly graceMs?: number;
  readonly now?: number;
}

/** Decide what to delete. Pure apart from reading the blob directory. */
export async function planBlobGc(opts: PlanBlobGcOptions): Promise<BlobGcPlan> {
  const graceMs = opts.graceMs ?? DEFAULT_BLOB_GC_GRACE_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - graceMs;

  let names: string[];
  try {
    names = await fs.promises.readdir(opts.blobsDir);
  } catch (err) {
    // A server that has never stored a blob has no blobs dir yet: it is
    // created lazily by FsBlobStorage. Nothing to do, and emphatically not a
    // failure - a loud error every sweep would train operators to ignore the
    // one log line that makes a dead GC visible.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deleteHashes: [], deleteTmpPaths: [], kept: 0, roomLogs: opts.roomLogs };
    }
    throw err;
  }

  const deleteHashes: string[] = [];
  const deleteTmpPaths: string[] = [];
  let kept = 0;

  for (const name of names) {
    const full = path.join(opts.blobsDir, name);
    if (TMP_REGEX.test(name)) {
      const stat = await fs.promises.stat(full).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) deleteTmpPaths.push(full);
      continue;
    }
    if (!HASH_REGEX.test(name)) continue;
    if (opts.referenced.has(name)) {
      kept += 1;
      continue;
    }
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat || stat.mtimeMs >= cutoff) {
      kept += 1;
      continue;
    }
    deleteHashes.push(name);
  }

  if (opts.roomLogs === 0 && deleteHashes.length > 0) {
    throw new Error(
      `[blob-gc] found ${deleteHashes.length} unreferenced blob(s) but ZERO room logs; ` +
        'refusing to sweep, since this is what a wrong dataDir looks like',
    );
  }

  return { deleteHashes, deleteTmpPaths, kept, roomLogs: opts.roomLogs };
}

/** Blob storage able to delete only if the file is older than a cutoff. */
export interface GcBlobStorage {
  deleteIfOlderThan(hash: string, cutoffEpochMs: number): Promise<boolean>;
}

export interface BlobGcResult {
  readonly deletedBlobs: number;
  readonly deletedTmp: number;
  readonly kept: number;
  readonly roomLogs: number;
}

/**
 * Execute a plan. Deletion goes through `deleteIfOlderThan` rather than a bare
 * unlink so a blob re-uploaded between planning and applying survives: the
 * storage re-checks mtime under the same per-hash lock the writer takes.
 */
export async function applyBlobGc(
  storage: GcBlobStorage,
  plan: BlobGcPlan,
  cutoffEpochMs: number,
): Promise<BlobGcResult> {
  let deletedBlobs = 0;
  for (const hash of plan.deleteHashes) {
    if (await storage.deleteIfOlderThan(hash, cutoffEpochMs)) deletedBlobs += 1;
  }
  let deletedTmp = 0;
  for (const tmp of plan.deleteTmpPaths) {
    try {
      await fs.promises.unlink(tmp);
      deletedTmp += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return { deletedBlobs, deletedTmp, kept: plan.kept, roomLogs: plan.roomLogs };
}

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
