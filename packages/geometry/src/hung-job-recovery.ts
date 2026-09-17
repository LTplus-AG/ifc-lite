/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hung-job recovery for the parallel geometry pool (#4884).
 *
 * A geometry worker runs one synchronous WASM call at a time. When a single
 * element's geometry never finishes (an unbounded tessellation / sweep / CDT
 * loop), that call never returns, the worker never reaches its queued chunks,
 * and nothing on the host could time it out: the consumer's stream watchdog
 * failed the WHOLE load once every other worker had drained. Production showed
 * the signature plainly — the same model stalling at the exact same mesh count
 * on every attempt, including the lower-detail resource retry.
 *
 * This module is the host's bookkeeping for escaping that: it remembers which
 * job slices each worker has been sent but not finished, which call is in
 * flight, and when the worker last spoke. When a busy worker stays silent past
 * the hang budget, the pool terminates it, spawns a replacement, and replays
 * the unfinished work from the {@link RecoveryPlan}:
 *
 *  - an in-flight call of ONE job is the culprit — it is skipped and reported;
 *  - an in-flight call of several jobs is re-run one job per call
 *    (`maxBatchJobs: 1`), so the next stall (if any) isolates the element in
 *    exactly one more budget instead of a log2 bisection;
 *  - the rest of the slice and every later queued slice are replayed as-is.
 *
 * Nothing is emitted twice: a worker posts a call's meshes only after the call
 * returns, and always before the `progress` of its next call, so everything the
 * host already received is strictly before the in-flight range.
 *
 * The ledger is pure bookkeeping (no Worker, no timers) so the policy is
 * unit-testable; {@link startHungJobMonitor} applies it to a live pool.
 */

/** Silence budget for one busy worker inside a MULTI-job call before it is
 *  replaced (the value a consumer opts in with; recovery is off by default).
 *  Above the viewer's 40 s mid-stream watchdog (watchdog.ts), so no call that
 *  loaded before recovery existed is disturbed: replacing a worker is not free
 *  on huge files (a fresh wasm heap plus a source copy). Such a call is re-run
 *  one job per call, never skipped, so a false positive costs time only. */
export const DEFAULT_HUNG_JOB_TIMEOUT_MS = 45_000;

/** A SINGLE-job call is only skipped after this multiple of the budget (90 s by
 *  default), so an element that is merely slow is never dropped. */
export const SINGLE_JOB_SKIP_FACTOR = 2;

/** Once a busy worker has been silent for this fraction of the budget (30 s by
 *  default, under the viewer's 40 s watchdog) the monitor reports pool liveness
 *  until the call returns or is recovered: the pool, not the consumer's
 *  watchdog, bounds that call from here on. */
const LIVENESS_AFTER_FRACTION = 2 / 3;

/** Monitor ticks further apart than this many intervals mean the host was
 *  suspended (sleep, frozen tab). Worker messages posted meanwhile are still
 *  queued behind the tick, so silence measured across the gap is not evidence. */
const SUSPEND_GAP_INTERVALS = 3;

/** Upper bound on worker replacements per load. A model where element after
 *  element hangs is not one bad element; past this the pool stops recovering
 *  and the consumer watchdog reports the stall as before. */
export const MAX_HUNG_JOB_RECOVERIES = 16;

/** One unfinished job slice as dispatched to a worker. */
export interface LedgerSlice {
  seq: number;
  /** Flat `[expressId, byteStart, byteEnd]` triples — a private copy. */
  jobs: Uint32Array;
  /** Per-call job cap forwarded with the chunk; undefined = adaptive sizing. */
  maxBatchJobs?: number;
}

/** The unfinished work of a hung worker, in replay order. */
export interface RecoveryPlan {
  /** The single job whose call never returned; skipped. Null when the hung call
   *  held several jobs (they are in `slices`, capped at one job per call). */
  skippedJob: Uint32Array | null;
  /** Slices to re-dispatch to the replacement worker, in order. */
  slices: Array<Omit<LedgerSlice, 'seq'>>;
}

interface WorkerLedgerState {
  slices: LedgerSlice[];
  /** The call currently inside WASM, as reported by the worker's pre-call heartbeat. */
  inFlight: { seq: number; fromJob: number; callJobs: number } | null;
  /** Size of the worker's last call that returned: its learned adaptive batch. */
  lastReturnedCallJobs: number | undefined;
  lastHeardAt: number;
}

export class WorkerJobLedger {
  private readonly states: WorkerLedgerState[] = [];
  private nextSeq = 0;

  /**
   * @param retainSlices Keep a copy of every dispatched slice for replay. False
   *   when recovery is disabled, so a pool that cannot recover pays nothing.
   */
  constructor(workerCount: number, now: number, private readonly retainSlices = true) {
    for (let i = 0; i < workerCount; i++) this.states.push(emptyState(now));
  }

  /** Record a chunk before it is transferred to `worker`; returns its seq. */
  recordDispatch(worker: number, jobs: Uint32Array, maxBatchJobs?: number): number {
    const seq = this.nextSeq++;
    if (!this.retainSlices) return seq;
    this.states[worker].slices.push({
      seq,
      jobs: jobs.slice(),
      ...(maxBatchJobs !== undefined ? { maxBatchJobs } : {}),
    });
    return seq;
  }

  /** Any message from the worker proves it is alive. */
  onHeard(worker: number, now: number): void {
    this.states[worker].lastHeardAt = now;
  }

  /** Pre-call heartbeat: the worker is about to run `callJobs` jobs of slice `seq`. */
  onCallStart(worker: number, seq: number, fromJob: number, callJobs: number, now: number): void {
    const state = this.states[worker];
    state.lastHeardAt = now;
    // Slices are processed in dispatch order, so any earlier slice is finished.
    state.slices = state.slices.filter((s) => s.seq >= seq);
    if (state.inFlight) state.lastReturnedCallJobs = state.inFlight.callJobs;
    state.inFlight = { seq, fromJob, callJobs };
  }

  /** The worker finished every call of slice `seq`. */
  onSliceDone(worker: number, seq: number, now: number): void {
    const state = this.states[worker];
    state.lastHeardAt = now;
    state.slices = state.slices.filter((s) => s.seq > seq);
    if (state.inFlight && state.inFlight.seq <= seq) {
      state.lastReturnedCallJobs = state.inFlight.callJobs;
      state.inFlight = null;
    }
  }

  /** The host was suspended: restart every silence clock (see SUSPEND_GAP_INTERVALS). */
  onHostResumed(now: number): void {
    for (const state of this.states) state.lastHeardAt = now;
  }

  /**
   * Workers to replace: silent inside a multi-job call for `timeoutMs`, or inside
   * a single-job call for `timeoutMs * SINGLE_JOB_SKIP_FACTOR`.
   */
  findHung(now: number, timeoutMs: number): number[] {
    const hung: number[] = [];
    this.states.forEach((state, worker) => {
      if (state.inFlight && now - state.lastHeardAt >= budgetFor(state.inFlight.callJobs, timeoutMs)) hung.push(worker);
    });
    return hung;
  }

  /** True while some busy worker is silent long enough that the consumer's
   *  watchdog could fire, yet not long enough to be recovered. */
  needsLiveness(now: number, timeoutMs: number): boolean {
    return this.states.some((state) => {
      if (!state.inFlight) return false;
      const silent = now - state.lastHeardAt;
      return silent >= timeoutMs * LIVENESS_AFTER_FRACTION && silent < budgetFor(state.inFlight.callJobs, timeoutMs);
    });
  }

  /**
   * Take the unfinished work of a hung worker and reset its slot for the
   * replacement (which re-records the plan's slices as it dispatches them).
   */
  takeRecoveryPlan(worker: number, now: number): RecoveryPlan {
    const state = this.states[worker];
    const inFlight = state.inFlight;
    const pending = state.slices;
    this.states[worker] = emptyState(now);
    // A fresh worker restarts adaptive sizing at its maximum; in the dense region
    // that just hung, that can trip the budget again. Keep the learned size.
    const capOf = (slice: LedgerSlice) => slice.maxBatchJobs ?? state.lastReturnedCallJobs;

    const plan: RecoveryPlan = { skippedJob: null, slices: [] };
    for (const slice of pending) {
      if (!inFlight || slice.seq !== inFlight.seq) {
        plan.slices.push(withCap(slice.jobs, capOf(slice)));
        continue;
      }
      const callStart = inFlight.fromJob * 3;
      const callEnd = Math.min(slice.jobs.length, callStart + inFlight.callJobs * 3);
      const call = slice.jobs.subarray(callStart, callEnd);
      if (call.length === 3) {
        plan.skippedJob = call.slice();
      } else if (call.length > 0) {
        plan.slices.push(withCap(call.slice(), 1));
      }
      if (callEnd < slice.jobs.length) {
        plan.slices.push(withCap(slice.jobs.slice(callEnd), capOf(slice)));
      }
    }
    return plan;
  }
}

function emptyState(now: number): WorkerLedgerState {
  return { slices: [], inFlight: null, lastReturnedCallJobs: undefined, lastHeardAt: now };
}

function budgetFor(callJobs: number, timeoutMs: number): number {
  return callJobs === 1 ? timeoutMs * SINGLE_JOB_SKIP_FACTOR : timeoutMs;
}

function withCap(jobs: Uint32Array, maxBatchJobs: number | undefined): Omit<LedgerSlice, 'seq'> {
  return maxBatchJobs !== undefined ? { jobs, maxBatchJobs } : { jobs };
}

/**
 * The IFC entity keyword of a job (`IFCWALL`), read from the source bytes the
 * job points at. A schema constant, never user data, so it is safe to report;
 * anything that does not look like a keyword comes back as `'UNKNOWN'`.
 */
export function readJobIfcType(source: Uint8Array, job: Uint32Array): string {
  const start = job[1];
  const end = Math.min(job[2], source.length, start + 256);
  let i = start;
  while (i < end && source[i] !== 0x3d /* = */) i++;
  i++;
  while (i < end && (source[i] === 0x20 || source[i] === 0x09)) i++;
  let keyword = '';
  for (; i < end; i++) {
    const c = source[i];
    const isUpper = c >= 0x41 && c <= 0x5a;
    const isLower = c >= 0x61 && c <= 0x7a;
    const isDigit = c >= 0x30 && c <= 0x39;
    if (!isUpper && !isLower && !isDigit && c !== 0x5f) break;
    keyword += String.fromCharCode(isLower ? c - 0x20 : c);
  }
  return /^IFC[A-Z0-9_]+$/.test(keyword) ? keyword : 'UNKNOWN';
}

/** Elements the pool skipped because their geometry never finished. */
export interface SkippedHungElements {
  /** Express ids of the skipped elements, in skip order. */
  expressIds: number[];
  /** Skipped elements by IFC entity keyword, count-desc then keyword-asc. */
  byType: Array<{ ifcType: string; count: number }>;
}

/** Accumulates skipped jobs into the `complete` event's report. */
export class SkippedHungElementsCollector {
  private readonly expressIds: number[] = [];
  private readonly counts = new Map<string, number>();

  add(source: Uint8Array, job: Uint32Array): void {
    this.expressIds.push(job[0]);
    const ifcType = readJobIfcType(source, job);
    this.counts.set(ifcType, (this.counts.get(ifcType) ?? 0) + 1);
  }

  get size(): number {
    return this.expressIds.length;
  }

  report(): SkippedHungElements | undefined {
    if (this.expressIds.length === 0) return undefined;
    const byType = [...this.counts.entries()]
      .map(([ifcType, count]) => ({ ifcType, count }))
      .sort((a, b) => b.count - a.count || a.ifcType.localeCompare(b.ifcType));
    return { expressIds: [...this.expressIds], byType };
  }
}

/** What the monitor needs from the pool that owns the workers. */
export interface HungJobPool {
  /** The live pool; a replaced slot is overwritten in place. */
  workers: Worker[];
  ledger: WorkerJobLedger;
  makeWorker: () => Worker;
  installHandlers: (worker: Worker, index: number) => void;
  /** Every per-load state message, in order, as recorded by the pool. */
  setup: ReadonlyArray<(worker: Worker) => void>;
  postChunk: (index: number, jobs: Uint32Array, maxBatchJobs?: number) => void;
  streamEndSent: () => boolean;
  terminate: (worker: Worker, label: string) => void;
  /** File bytes the jobs point into, for the skipped elements' IFC types. */
  source: Uint8Array;
  skipped: SkippedHungElementsCollector;
  /** False once the stream failed or was aborted. */
  isLive: () => boolean;
  /** A worker was replaced, or a single-job call is in its skip grace: the
   *  consumer's watchdog should see liveness. */
  onLiveness: () => void;
  onFailed: (error: Error) => void;
}

/**
 * Poll the ledger and replace every worker that stayed silent inside one call
 * for `timeoutMs`. Returns the stop function; `timeoutMs <= 0` disables it.
 */
export function startHungJobMonitor(pool: HungJobPool, timeoutMs: number): () => void {
  if (timeoutMs <= 0) return () => {};
  let recoveries = 0;
  const replace = (i: number) => {
    recoveries++;
    const plan = pool.ledger.takeRecoveryPlan(i, performance.now());
    const hung = pool.workers[i];
    const replacement = pool.makeWorker();
    // Swap first: the pool's stale-worker guard then drops anything the hung one flushes.
    pool.workers[i] = replacement;
    pool.terminate(hung, 'hung process worker');
    pool.installHandlers(replacement, i);
    for (const setup of pool.setup) setup(replacement);
    if (plan.skippedJob) pool.skipped.add(pool.source, plan.skippedJob);
    for (const slice of plan.slices) pool.postChunk(i, slice.jobs, slice.maxBatchJobs);
    if (pool.streamEndSent()) replacement.postMessage({ type: 'stream-end' });
    console.warn(
      `[stream] worker[${i}] silent for ${budgetFor(plan.skippedJob ? 1 : 2, timeoutMs)}ms inside one geometry call — replaced ` +
        (plan.skippedJob ? `and skipped entity #${plan.skippedJob[0]}` : 'and re-running that call one job at a time') +
        ` (recovery ${recoveries}/${MAX_HUNG_JOB_RECOVERIES})`,
    );
    pool.onLiveness();
  };
  const intervalMs = Math.min(2_000, timeoutMs);
  let lastTickAt = performance.now();
  // A worker must look hung on two consecutive ticks: messages it posted just
  // before a tick are delivered between ticks, never skipped past.
  let suspects = new Set<number>();
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - lastTickAt;
    lastTickAt = now;
    if (gap > intervalMs * SUSPEND_GAP_INTERVALS) {
      pool.ledger.onHostResumed(now);
      suspects = new Set();
      return;
    }
    // Past the cap nothing is recovered, so nothing may mask the consumer's watchdog.
    if (!pool.isLive() || recoveries >= MAX_HUNG_JOB_RECOVERIES) return;
    if (pool.ledger.needsLiveness(now, timeoutMs)) pool.onLiveness();
    const hung = pool.ledger.findHung(now, timeoutMs);
    const confirmed = hung.filter((i) => suspects.has(i));
    suspects = new Set(hung.filter((i) => !suspects.has(i)));
    for (const i of confirmed) {
      if (recoveries >= MAX_HUNG_JOB_RECOVERIES) return;
      try {
        replace(i);
      } catch (err) {
        pool.onFailed(new Error(
          `Geometry worker failed: hung-worker replacement failed (${err instanceof Error ? err.message : String(err)})`,
        ));
        return;
      }
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
