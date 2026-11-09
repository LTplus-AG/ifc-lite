/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAbortError } from '@/lib/runs/abort';
import type { CancelReason } from '@/lib/runs/run';

export type { CancelReason } from '@/lib/runs/run';

/**
 * A component's async run as ONE value. Exactly one of these holds at a time,
 * so "busy and errored", "result from the previous run under a new spinner"
 * and "cancelled shown as an error" cannot be expressed.
 */
export type AsyncRunState<R, P = never> =
  | { kind: 'idle' }
  | { kind: 'running'; progress?: P }
  | { kind: 'succeeded'; result: R }
  | { kind: 'failed'; error: unknown }
  /** Only a user cancel (`cancel()`, or an `AbortError` from the task) is shown as a state. */
  | { kind: 'cancelled'; reason: 'user' };

/**
 * How one `start` ended, for the caller that awaits it.
 * - `refused`: another run owned the hook; the task was never called.
 * - `cancelled`: the run ended without a result, and `reason` says why:
 *   `user` (`cancel()`, or the task threw an `AbortError`), `superseded`
 *   (`restart`), `teardown` (`reset`, a `key` change, unmount, or `start`
 *   called after unmount, in which case the task was never called).
 *   Whatever the task returned was discarded.
 */
export type AsyncRunOutcome<R> =
  | { kind: 'refused' }
  | { kind: 'succeeded'; result: R }
  | { kind: 'failed'; error: unknown }
  | { kind: 'cancelled'; reason: Exclude<CancelReason, 'scope'> };

/** What a task receives. */
export interface AsyncRunContext<P> {
  /** Aborts when the run loses ownership. Pass it to `fetch`, workers, other runs. */
  signal: AbortSignal;
  /**
   * True while this run still owns the hook. Check it after every `await`
   * before a side effect the hook does not make for you (a toast, a store
   * write, a parent callback).
   */
  isCurrent: () => boolean;
  /** Publish progress into `state`; ignored once the run is no longer current. */
  progress: (value: P) => void;
}

export type AsyncRunTask<R, P> = (run: AsyncRunContext<P>) => Promise<R>;

export interface AsyncRun<R = void, P = never> {
  state: AsyncRunState<R, P>;
  /** `state.kind === 'running'`, for disabling controls. */
  busy: boolean;
  /**
   * Run `task` unless a run is in flight (then `refused`, synchronously, so a
   * second press in the same tick never reaches the task). Never rejects:
   * a failure lands in `state` and in the outcome.
   */
  start: (task: AsyncRunTask<R, P>) => Promise<AsyncRunOutcome<R>>;
  /** Like `start`, but a run in flight is aborted and superseded instead (type-ahead search). */
  restart: (task: AsyncRunTask<R, P>) => Promise<AsyncRunOutcome<R>>;
  /** Abort the run in flight; `state` becomes `cancelled` (reason `user`). No-op when idle. */
  cancel: () => void;
  /** Abort any run in flight and return to `idle` (a form closed or discarded). */
  reset: () => void;
}

export interface UseAsyncRunOptions {
  /**
   * The subject the run belongs to (an entity id, a dialog's target). When it
   * changes, the run in flight is aborted and `state` returns to `idle`, so a
   * late answer for the previous subject never lands on the new one.
   */
  key?: unknown;
  /** Prefix for the console line a failed run logs. */
  label?: string;
}

const IDLE = { kind: 'idle' } as const;
const USER_CANCELLED = { kind: 'cancelled', reason: 'user' } as const;
const REFUSED = { kind: 'refused' } as const;

type LostReason = Exclude<CancelReason, 'scope'>;

interface Lease {
  readonly controller: AbortController;
  /** Set when the run lost ownership: what its outcome reports. */
  lost?: LostReason;
}

/**
 * Component-local async run ownership (implicit-state audit, section 2.2): the
 * one shape for "a button starts async work".
 *
 * Guarantees, each of which a hand-rolled `busy`/`error`/`result` trio gets
 * wrong somewhere in the viewer:
 * - **No double submit.** Ownership is a ref taken synchronously in `start`,
 *   so two presses inside one tick (double-click, Enter + click) run the task
 *   once; `busy` is only render state for disabling controls.
 * - **Owner-checked settle.** Only the run that still owns the hook writes
 *   `state`; an abandoned run settling late cannot clear a newer run's busy,
 *   publish its result, or show its error.
 * - **Abort, not just ignore.** Unmount, a `key` change, `cancel`, `reset`
 *   and `restart` abort the run's `signal`, so its fetch or worker stops too.
 * - **Abort is not failure.** An `AbortError` is `cancelled`, never shown
 *   as an error.
 *
 * Before (the trio, with its four races):
 * ```tsx
 * const [busy, setBusy] = useState(false);
 * const [error, setError] = useState<string | null>(null);
 * const save = async () => {
 *   if (busy) return;                       // stale closure: a double-click passes
 *   setBusy(true); setError(null);
 *   try { await saveThing(id); toast.success('Saved'); }
 *   catch (e) { setError(String(e)); }      // an abort shows as an error
 *   finally { setBusy(false); }             // clears a newer run's busy
 * };
 * ```
 * After:
 * ```tsx
 * const save = useAsyncRun({ key: id });    // a new id aborts the old save
 * const onSave = () => save.start(async ({ signal, isCurrent }) => {
 *   await saveThing(id, { signal });
 *   if (isCurrent()) toast.success('Saved');
 * });
 * // <Button disabled={save.busy} onClick={() => void onSave()} />
 * // {save.state.kind === 'failed' && <Alert>{String(save.state.error)}</Alert>}
 * ```
 *
 * A failed run is logged (`console.warn`) as well as stored, so a caller that
 * never renders `state.error` does not swallow it. Work that must outlive the
 * component or be visible to other components belongs in the store run slot
 * (`lib/runs/run-slot.ts`), not here.
 *
 * `start` after the component unmounted never calls the task: there is no
 * owner left to abort it or to show its result, so it returns `cancelled`
 * with reason `teardown`.
 *
 * StrictMode: React's development double-invoke of effects (mount, cleanup,
 * mount) does not touch a run, because a run can only start from a handler
 * after the effects ran; `useAsyncRun.test.tsx` renders under `<StrictMode>`
 * to pin that.
 *
 * Migrating from `useSingleFlight` (#9495), behaviour that changes:
 * - `run(task)` becomes `start(task)`; the task takes `{ signal, isCurrent,
 *   progress }` instead of `isCurrent`, and the outcome is `kind`, not `status`
 *   (`refused` | `succeeded` | `failed` | `cancelled`; `stale` is `cancelled`).
 * - `release()` becomes `reset()`, and it, unmount and a `key` change now
 *   ABORT the run's signal instead of only marking it stale.
 * - A task that throws no longer rejects `start`: the error lands in
 *   `state.failed` and the outcome, and is logged with `console.warn`. Callers
 *   that relied on the rejection (an unhandled one, in practice) now get the log.
 * - The result type `R` is fixed per hook (`useAsyncRun<R>()`), not per call;
 *   a hook whose tasks return nothing is `useAsyncRun()` (`R = void`).
 * - `busy` is `state.kind === 'running'`; a finished run leaves `succeeded`,
 *   `failed` or `cancelled` in `state` rather than an implicit idle.
 */
export function useAsyncRun<R = void, P = never>(options: UseAsyncRunOptions = {}): AsyncRun<R, P> {
  const { key, label = 'async run' } = options;
  const flight = useRef<Lease | null>(null);
  const mounted = useRef(true);
  const labelRef = useRef(label);
  labelRef.current = label;
  const [state, setState] = useState<AsyncRunState<R, P>>(IDLE);

  /** Drop ownership and abort; the caller decides what `state` becomes. */
  const abandon = useCallback((reason: LostReason): boolean => {
    const lease = flight.current;
    if (!lease) return false;
    flight.current = null;
    lease.lost = reason;
    lease.controller.abort();
    return true;
  }, []);

  const keyRef = useRef(key);
  useEffect(() => {
    mounted.current = true;
    // A new subject starts from idle (the cleanup below already aborted the old run).
    if (!Object.is(keyRef.current, key)) {
      keyRef.current = key;
      setState(IDLE);
    }
    return () => {
      mounted.current = false;
      abandon('teardown');
    };
  }, [key, abandon]);

  const write = useCallback((next: AsyncRunState<R, P>) => {
    if (mounted.current) setState(next);
  }, []);

  const launch = useCallback(async (task: AsyncRunTask<R, P>, supersede: boolean): Promise<AsyncRunOutcome<R>> => {
    // No owner left: nothing would abort the task or show its result.
    if (!mounted.current) return { kind: 'cancelled', reason: 'teardown' };
    if (flight.current && !supersede) return REFUSED;
    abandon('superseded');
    const lease: Lease = { controller: new AbortController() };
    flight.current = lease;
    const isCurrent = () => flight.current === lease;
    const context: AsyncRunContext<P> = {
      signal: lease.controller.signal,
      isCurrent,
      progress: (value) => { if (isCurrent()) write({ kind: 'running', progress: value }); },
    };
    write({ kind: 'running' });
    let result: R;
    try {
      result = await task(context);
    } catch (error) {
      if (!isCurrent()) {
        // Lost ownership: its state was already settled by whoever took it.
        // An AbortError is the abort unwinding; anything else is still logged.
        if (!isAbortError(error)) console.warn(`[${labelRef.current}] An abandoned run failed`, error);
        return { kind: 'cancelled', reason: lease.lost ?? 'teardown' };
      }
      flight.current = null;
      if (isAbortError(error)) {
        write(USER_CANCELLED);
        return USER_CANCELLED;
      }
      console.warn(`[${labelRef.current}] Run failed`, error);
      write({ kind: 'failed', error });
      return { kind: 'failed', error };
    }
    if (!isCurrent()) return { kind: 'cancelled', reason: lease.lost ?? 'teardown' };
    flight.current = null;
    write({ kind: 'succeeded', result });
    return { kind: 'succeeded', result };
  }, [abandon, write]);

  const start = useCallback((task: AsyncRunTask<R, P>) => launch(task, false), [launch]);
  const restart = useCallback((task: AsyncRunTask<R, P>) => launch(task, true), [launch]);
  const cancel = useCallback(() => { if (abandon('user')) write(USER_CANCELLED); }, [abandon, write]);
  const reset = useCallback(() => { abandon('teardown'); write(IDLE); }, [abandon, write]);

  return useMemo(() => ({ state, busy: state.kind === 'running', start, restart, cancel, reset }), [state, start, restart, cancel, reset]);
}
