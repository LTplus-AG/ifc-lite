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

/** Silence budget for one busy worker before it is treated as hung. Below the
 *  viewer's 40 s mid-stream watchdog (watchdog.ts) so recovery always runs
 *  before the consumer gives up on the stream, and far above the worker's
 *  adaptive per-call target (~8 s). A healthy-but-slow call that trips it is
 *  re-run one job per call, never skipped, so a false positive costs time only. */
export const DEFAULT_HUNG_JOB_TIMEOUT_MS = 30_000;

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
  lastHeardAt: number;
}

export class WorkerJobLedger {
  private readonly states: WorkerLedgerState[] = [];
  private nextSeq = 0;

  constructor(workerCount: number, now: number) {
    for (let i = 0; i < workerCount; i++) {
      this.states.push({ slices: [], inFlight: null, lastHeardAt: now });
    }
  }

  /** Record a chunk before it is transferred to `worker`; returns its seq. */
  recordDispatch(worker: number, jobs: Uint32Array, maxBatchJobs?: number): number {
    const seq = this.nextSeq++;
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
    state.inFlight = { seq, fromJob, callJobs };
  }

  /** The worker finished every call of slice `seq`. */
  onSliceDone(worker: number, seq: number, now: number): void {
    const state = this.states[worker];
    state.lastHeardAt = now;
    state.slices = state.slices.filter((s) => s.seq > seq);
    if (state.inFlight && state.inFlight.seq <= seq) state.inFlight = null;
  }

  /** Workers inside a WASM call that have been silent for at least `timeoutMs`. */
  findHung(now: number, timeoutMs: number): number[] {
    const hung: number[] = [];
    this.states.forEach((state, worker) => {
      if (state.inFlight && now - state.lastHeardAt >= timeoutMs) hung.push(worker);
    });
    return hung;
  }

  /**
   * Take the unfinished work of a hung worker and reset its slot for the
   * replacement (which re-records the plan's slices as it dispatches them).
   */
  takeRecoveryPlan(worker: number, now: number): RecoveryPlan {
    const state = this.states[worker];
    const inFlight = state.inFlight;
    const pending = state.slices;
    this.states[worker] = { slices: [], inFlight: null, lastHeardAt: now };

    const plan: RecoveryPlan = { skippedJob: null, slices: [] };
    for (const slice of pending) {
      if (!inFlight || slice.seq !== inFlight.seq) {
        plan.slices.push(withCap(slice.jobs, slice.maxBatchJobs));
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
        plan.slices.push(withCap(slice.jobs.slice(callEnd), slice.maxBatchJobs));
      }
    }
    return plan;
  }
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
  /** A worker was replaced: the consumer's watchdog should see liveness. */
  onReplaced: () => void;
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
      `[stream] worker[${i}] silent for ${timeoutMs}ms inside one geometry call — replaced ` +
        (plan.skippedJob ? `and skipped entity #${plan.skippedJob[0]}` : 'and re-running that call one job at a time') +
        ` (recovery ${recoveries}/${MAX_HUNG_JOB_RECOVERIES})`,
    );
    pool.onReplaced();
  };
  const timer = setInterval(() => {
    if (!pool.isLive()) return;
    for (const i of pool.ledger.findHung(performance.now(), timeoutMs)) {
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
  }, Math.min(2_000, timeoutMs));
  return () => clearInterval(timer);
}
