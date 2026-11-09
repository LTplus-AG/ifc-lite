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
 * description and every begin, progress, end and invalidation is mirrored as
 * the job's tray row, with the tray's Cancel wired to the lease. Nothing else
 * records the job, so the row cannot disagree with the store.
 */

import {
  beginActivity, finishActivity, updateActivity, type ActivityJob, type BeginActivity,
} from '@/lib/activity/activity-journal';
import { assertNever } from '@/lib/assert-never';
import type { Run } from './run';

export { IDLE_RUN, type Run } from './run';

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
   * `succeed`: false discards the result and ends the run `cancelled`. Use
   * `federationIsCurrent` (`lib/federation/federation-identity.ts`) over the
   * identity captured at begin.
   */
  scopeIsCurrent?: () => boolean;
}

export interface RunLease<R, P, E> {
  readonly runId: number;
  /** Aborts when the lease goes stale: cancelled, superseded or torn down. */
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  /** Each returns whether it wrote; false means the lease was already stale. */
  progress(value: P): boolean;
  /** False also when `scopeIsCurrent` says the result describes a world that is gone. */
  succeed(result: R): boolean;
  fail(error: E): boolean;
  cancel(): boolean;
}

export interface RunSlot<R, P, O, E> {
  /** Start a run, superseding (and aborting) any run in flight. */
  begin(owner: O, options?: BeginRunOptions): RunLease<R, P, E>;
  /** Cancel the run in flight, whoever started it. Returns whether one was running. */
  cancel(): boolean;
}

function describeError(error: unknown): Pick<ActivityJob, 'detail'> {
  return { detail: error instanceof Error ? error.message : String(error) };
}

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

  const cancelCurrent = (): boolean => {
    const record = binding.read();
    if (record.kind !== 'running') return false;
    binding.write({ kind: 'cancelled', runId: record.runId });
    return true;
  };

  const begin = (owner: O, options: BeginRunOptions = {}): RunLease<R, P, E> => {
    const runId = ++nextRunId;
    const controller = new AbortController();
    let ended = false;
    let journalId: string | null = null;

    type End = { kind: 'succeeded' } | { kind: 'failed'; error: E } | { kind: 'cancelled' };
    /** Stop watching, abort when the run did not succeed, settle the tray row. Idempotent. */
    const end = (how: End) => {
      if (ended) return;
      ended = true;
      unsubscribe();
      if (how.kind !== 'succeeded') controller.abort();
      if (journalId === null) return;
      switch (how.kind) {
        case 'succeeded': finishActivity(journalId, 'completed'); break;
        case 'failed': finishActivity(journalId, 'failed', (activity?.detail ?? describeError)(how.error)); break;
        case 'cancelled': finishActivity(journalId, 'cancelled'); break;
        default: assertNever(how, 'run end');
      }
    };

    const isCurrent = () => !ended && isRunning(runId);

    // Supersede: the write below is what ends the older lease (its watcher sees a new id).
    binding.write({ kind: 'running', runId, owner });
    // Subscribed after the write, so only a LATER change can end this lease.
    const unsubscribe = binding.subscribe(() => {
      if (!ended && !isRunning(runId)) end({ kind: 'cancelled' });
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
          end({ kind: 'cancelled' });
          binding.write({ kind: 'cancelled', runId });
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
        binding.write({ kind: 'cancelled', runId });
        return true;
      },
    };

    const row = activity?.begin(owner) ?? null;
    if (row && isCurrent()) journalId = beginActivity({ ...row, cancel: () => { lease.cancel(); } });
    return lease;
  };

  return { begin, cancel: cancelCurrent };
}
