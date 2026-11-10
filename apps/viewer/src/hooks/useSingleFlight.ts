/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * How a {@link SingleFlight} run ended:
 * - `refused`: another run owned the flight, so `task` was never called;
 * - `stale`: `task` finished after the run was released (or the owner unmounted);
 * - `done`: `task` finished while it still owned the flight.
 */
export type SingleFlightResult<T> =
  | { status: 'refused' }
  | { status: 'stale'; value: T }
  | { status: 'done'; value: T };

/**
 * One in-flight async run per owner. The guard is a synchronous ref, so a
 * second press in the same tick (double-click, Enter + click) is refused
 * before React re-renders; `busy` is render state for disabling controls.
 * Only the run that still owns the flight may clear `busy`, so an abandoned
 * run settling late cannot clobber a newer one.
 *
 * Intentionally minimal: the planned `useAsyncRun` can subsume it with the
 * same `run`/`release` shape and add an `AbortSignal` so a released run can
 * stop its own work instead of only having its result ignored.
 */
export interface SingleFlight {
  /** True while a run owns the flight. */
  busy: boolean;
  /**
   * Start `task` unless a run is in flight. `isCurrent()` turns false once the
   * run is released or the owner unmounts. A rejection propagates to the
   * caller; `busy` still clears.
   */
  run: <T>(task: (isCurrent: () => boolean) => Promise<T>) => Promise<SingleFlightResult<T>>;
  /** Abandon the in-flight run so a new one may start; it becomes stale. */
  release: () => void;
}

export function useSingleFlight(): SingleFlight {
  const flight = useRef<object | null>(null);
  const [busy, setBusy] = useState(false);
  const release = useCallback(() => {
    if (!flight.current) return;
    flight.current = null;
    setBusy(false);
  }, []);
  useEffect(() => release, [release]);
  const run = useCallback(async <T,>(task: (isCurrent: () => boolean) => Promise<T>): Promise<SingleFlightResult<T>> => {
    if (flight.current) return { status: 'refused' };
    const lease = {};
    const isCurrent = () => flight.current === lease;
    flight.current = lease;
    setBusy(true);
    try {
      const value = await task(isCurrent);
      return isCurrent() ? { status: 'done', value } : { status: 'stale', value };
    } finally {
      if (isCurrent()) { flight.current = null; setBusy(false); }
    }
  }, []);
  return useMemo(() => ({ busy, run, release }), [busy, run, release]);
}
