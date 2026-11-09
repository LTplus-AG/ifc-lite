/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A store-level run slot (implicit-state audit, section 2.1): the one shape
 * for "a job whose state lives in the viewer store".
 *
 * The record IS the ownership. A run's lease is current exactly while the
 * store holds `{ kind: 'running', runId: <its id> }`, so anything that writes
 * the record ends the run: a newer `begin` (supersede), `cancel`, and a slice
 * teardown. That last one is the point. A `defineSliceTeardown` arm is a pure
 * patch, so it cannot reach a hook's epoch ref or an `AbortController`; here
 * it does not need to. It returns `{ kind: 'idle' }` for the slot's key, and
 * the lease, which watches its record, aborts its signal and goes stale.
 * Teardown therefore INVALIDATES the run (abort + a new id for whatever starts
 * next) instead of only flipping a `*Running` flag while the work carries on
 * and publishes into the next session (root cause 2 of the audit).
 *
 * Every lease method is a no-op once the lease is stale, so a late progress
 * report, result or error from an abandoned run cannot write anything.
 *
 * The activity journal is derived from the slot: give the slot an `activity`
 * description and every begin, progress and end is mirrored as the job's tray
 * row, with the tray's Cancel wired to the lease. A user cancel ends the row
 * `cancelled`; a superseded, torn-down or scope-dropped run removes its row
 * (`CancelReason` in `./run.ts`). Nothing else records the job, so the row
 * cannot disagree with the store.
 *
 * Start runs with `slot.run(owner, task, { toError })`: it settles the lease
 * from how the task ends and never rejects. `begin` is the manual form for a
 * caller that must settle the lease itself.
 */

import {
  beginActivity, discardActivity, finishActivity, updateActivity, type ActivityJob, type BeginActivity,
} from '@/lib/activity/activity-journal';
import { assertNever } from '@/lib/assert-never';
import { isAbortError } from './abort';
import type { CancelReason, Run } from './run';

export { IDLE_RUN, type CancelReason, type Run } from './run';

/** Where the slot's record lives. `write` is the store setter for that one key (plus whatever must change with it atomically). */
export interface RunSlotBinding<R, P, O, E> {
  read(): Run<R, P, O, E>;
  write(next: Run<R, P, O, E>): void;
  /** Called on every store change; the slot re-reads `read()` to see whether a lease lost its record. */
  subscribe(listener: () => void): () => void;
}

export interface RunSlotActivity<P, O, E> {
  /** The tray row for a run, or null to not journal this one. `cancel` is wired by the slot. */
  begin(owner: O): Omit<BeginActivity, 'cancel'> | null;
  /** The row's phase for a progress value. */
  phase?(progress: P): string | undefined;
  /** The row's failure detail: native text, or a catalogued key for a refusal code. Default: the error's message. */
  detail?(error: E): Pick<ActivityJob, 'detail' | 'detailKey'>;
}

export interface BeginRunOptions {
  /**
   * Is the world the run read still the one it will publish into? Checked at
   * `succeed`: false discards the result and ends the run cancelled with
   * reason `scope`. Use `federationIsCurrent`
   * (`lib/federation/federation-identity.ts`) over the identity captured at begin.
   */
  scopeIsCurrent?: () => boolean;
}

export interface RunOptions<E> extends BeginRunOptions {
  /** What a non-abort throw from the task is recorded as. */
  toError: (thrown: unknown) => E;
}

export interface RunLease<R, P, E> {
  readonly runId: number;
  /** Aborts when the lease goes stale: cancelled, superseded, torn down or scope-dropped. */
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  /** Each returns whether it wrote; false means the lease was already stale. */
  progress(value: P): boolean;
  /** False also when `scopeIsCurrent` says the result describes a world that is gone. */
  succeed(result: R): boolean;
  fail(error: E): boolean;
  /** A user cancel (reason `user`). */
  cancel(): boolean;
  /** Why the lease ended without a result, or null while current or after a success or failure. */
  cancelReason(): CancelReason | null;
}

export interface RunSlot<R, P, O, E> {
  /**
   * Run `task` under a fresh lease and settle it from how the task ends:
   * a return succeeds, an `AbortError` (`isAbortError`) cancels, any other
   * throw fails through `toError`. Never rejects, so a fire-and-forget
   * caller cannot leave the record `running` or an unhandled rejection.
   * Prefer this to `begin`: setup that throws after the run started is
   * inside the task, so it fails the run instead of stranding it.
   */
  run(owner: O, task: (lease: RunLease<R, P, E>) => Promise<R>, options: RunOptions<E>): Promise<void>;
  /** Start a run by hand, superseding (and aborting) any run in flight. The caller must settle the lease. */
  begin(owner: O, options?: BeginRunOptions): RunLease<R, P, E>;
  /** Cancel the run in flight (reason `user`), whoever started it. Returns whether one was running. */
  cancel(): boolean;
}

function describeError(error: unknown): Pick<ActivityJob, 'detail'> {
  return { detail: error instanceof Error ? error.message : String(error) };
}

type End<E> = { kind: 'succeeded' } | { kind: 'failed'; error: E } | { kind: 'cancelled'; reason: CancelReason };

export function createRunSlot<R, P = never, O = undefined, E = unknown>(
  binding: RunSlotBinding<R, P, O, E>,
  activity?: RunSlotActivity<P, O, E>,
): RunSlot<R, P, O, E> {
  /** Ids only grow, so a record written by an earlier lease (or a teardown) never matches a later one. */
  let nextRunId = 0;

  const isRunning = (runId: number): boolean => {
    const record = binding.read();
    return record.kind === 'running' && record.runId === runId;
  };

  /** Why `runId` no longer owns the record, read off what replaced it. */
  const lostTo = (runId: number): CancelReason => {
    const record = binding.read();
    if (record.kind === 'cancelled' && record.runId === runId) return record.reason;
    if (record.kind !== 'idle' && record.runId > runId) return 'superseded';
    return 'teardown';
  };

  const cancelCurrent = (): boolean => {
    const record = binding.read();
    if (record.kind !== 'running') return false;
    binding.write({ kind: 'cancelled', runId: record.runId, reason: 'user' });
    return true;
  };

  const begin = (owner: O, options: BeginRunOptions = {}): RunLease<R, P, E> => {
    const runId = ++nextRunId;
    const controller = new AbortController();
    let ended = false;
    let cancelReason: CancelReason | null = null;
    let journalId: string | null = null;

    /** Stop watching, abort when the run did not succeed, settle the tray row. Idempotent. */
    const end = (how: End<E>) => {
      if (ended) return;
      ended = true;
      if (how.kind === 'cancelled') cancelReason = how.reason;
      unsubscribe();
      if (how.kind !== 'succeeded') controller.abort();
      if (journalId === null) return;
      switch (how.kind) {
        case 'succeeded': finishActivity(journalId, 'completed'); break;
        case 'failed': finishActivity(journalId, 'failed', (activity?.detail ?? describeError)(how.error)); break;
        // Only a cancel the user caused is a "cancelled" row; a superseded,
        // torn-down or scope-dropped run leaves none.
        case 'cancelled':
          if (how.reason === 'user') finishActivity(journalId, 'cancelled');
          else discardActivity(journalId);
          break;
        default: assertNever(how, 'run end');
      }
    };

    const isCurrent = () => !ended && isRunning(runId);

    // Supersede: the write below is what ends the older lease (its watcher sees a newer id).
    binding.write({ kind: 'running', runId, owner });
    // Subscribed after the write, so only a LATER change can end this lease.
    const unsubscribe = binding.subscribe(() => {
      if (!ended && !isRunning(runId)) end({ kind: 'cancelled', reason: lostTo(runId) });
    });

    const lease: RunLease<R, P, E> = {
      runId,
      signal: controller.signal,
      isCurrent,
      progress: (value) => {
        if (!isCurrent()) return false;
        binding.write({ kind: 'running', runId, owner, progress: value });
        const phase = activity?.phase?.(value);
        if (journalId !== null && phase !== undefined) updateActivity(journalId, { phase });
        return true;
      },
      succeed: (result) => {
        if (!isCurrent()) return false;
        if (options.scopeIsCurrent && !options.scopeIsCurrent()) {
          end({ kind: 'cancelled', reason: 'scope' });
          binding.write({ kind: 'cancelled', runId, reason: 'scope' });
          return false;
        }
        end({ kind: 'succeeded' });
        binding.write({ kind: 'succeeded', runId, result });
        return true;
      },
      fail: (error) => {
        if (!isCurrent()) return false;
        end({ kind: 'failed', error });
        binding.write({ kind: 'failed', runId, error });
        return true;
      },
      cancel: () => {
        if (!isCurrent()) return false;
        // The watcher sees the cancelled record and ends the lease.
        binding.write({ kind: 'cancelled', runId, reason: 'user' });
        return true;
      },
      cancelReason: () => cancelReason,
    };

    const row = activity?.begin(owner) ?? null;
    if (row && isCurrent()) journalId = beginActivity({ ...row, cancel: () => { lease.cancel(); } });
    return lease;
  };

  const run: RunSlot<R, P, O, E>['run'] = async (owner, task, { toError, ...options }) => {
    const lease = begin(owner, options);
    let result: R;
    try {
      result = await task(lease);
    } catch (thrown) {
      // Both are no-ops once the lease is stale: whoever ended it already
      // settled the record, and aborted the signal the task is unwinding from.
      if (isAbortError(thrown)) lease.cancel();
      else lease.fail(toError(thrown));
      return;
    }
    lease.succeed(result);
  };

  return { run, begin, cancel: cancelCurrent };
}
