/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAbortError } from '@/lib/runs/abort';

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
  | { kind: 'cancelled' };

/**
 * How one `start` ended, for the caller that awaits it.
 * - `refused`: another run owned the hook; the task was never called.
 * - `cancelled`: aborted (an `AbortError`, or the signal fired), or the run
 *   lost ownership before it settled (cancel, reset, supersede, `key` change,
 *   unmount). Whatever it returned was discarded.
 */
export type AsyncRunOutcome<R> =
  | { kind: 'refused' }
  | { kind: 'succeeded'; result: R }
  | { kind: 'failed'; error: unknown }
  | { kind: 'cancelled' };

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

export interface AsyncRun<R, P = never> {
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
  /** Abort the run in flight; `state` becomes `cancelled`. No-op when idle. */
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
const CANCELLED = { kind: 'cancelled' } as const;
const REFUSED = { kind: 'refused' } as const;

interface Lease {
  readonly controller: AbortController;
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
 */
export function useAsyncRun<R = void, P = never>(options: UseAsyncRunOptions = {}): AsyncRun<R, P> {
  const { key, label = 'async run' } = options;
  const flight = useRef<Lease | null>(null);
  const mounted = useRef(true);
  const labelRef = useRef(label);
  labelRef.current = label;
  const [state, setState] = useState<AsyncRunState<R, P>>(IDLE);

  /** Drop ownership and abort; the caller decides what `state` becomes. */
  const abandon = useCallback((): boolean => {
    const lease = flight.current;
    if (!lease) return false;
    flight.current = null;
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
      abandon();
    };
  }, [key, abandon]);

  const write = useCallback((next: AsyncRunState<R, P>) => {
    if (mounted.current) setState(next);
  }, []);

  const launch = useCallback(async (task: AsyncRunTask<R, P>, supersede: boolean): Promise<AsyncRunOutcome<R>> => {
    if (flight.current && !supersede) return REFUSED;
    abandon();
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
        // Anything it throws after its signal fired is the abort unwinding.
        if (!lease.controller.signal.aborted && !isAbortError(error)) console.warn(`[${labelRef.current}] An abandoned run failed`, error);
        return CANCELLED;
      }
      flight.current = null;
      if (isAbortError(error)) {
        write(CANCELLED);
        return CANCELLED;
      }
      console.warn(`[${labelRef.current}] Run failed`, error);
      write({ kind: 'failed', error });
      return { kind: 'failed', error };
    }
    if (!isCurrent()) return CANCELLED;
    flight.current = null;
    write({ kind: 'succeeded', result });
    return { kind: 'succeeded', result };
  }, [abandon, write]);

  const start = useCallback((task: AsyncRunTask<R, P>) => launch(task, false), [launch]);
  const restart = useCallback((task: AsyncRunTask<R, P>) => launch(task, true), [launch]);
  const cancel = useCallback(() => { if (abandon()) write(CANCELLED); }, [abandon, write]);
  const reset = useCallback(() => { abandon(); write(IDLE); }, [abandon, write]);

  return useMemo(() => ({ state, busy: state.kind === 'running', start, restart, cancel, reset }), [state, start, restart, cancel, reset]);
}
