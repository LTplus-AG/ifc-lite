/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * One in-flight async run per owner. The guard is a synchronous ref, so a
 * second press in the same tick (double-click, Enter + click) is refused
 * before React re-renders; `busy` is render state for disabling controls.
 * Only the run that still owns the flight may clear `busy`, so an abandoned
 * run settling late cannot clobber a newer one. Intentionally minimal: a
 * fuller async-run hook can subsume it with the same `run`/`release` shape.
 */
export interface SingleFlight {
  /** True while a run owns the flight. */
  busy: boolean;
  /**
   * Start `task` unless a run is in flight (then resolves `undefined` without
   * calling it). `isCurrent()` turns false once the run is released or the
   * owner unmounts. A rejection propagates to the caller; `busy` still clears.
   */
  run: <T>(task: (isCurrent: () => boolean) => Promise<T>) => Promise<T | undefined>;
  /** Abandon the in-flight run so a new one may start; it becomes stale. */
  release: () => void;
}

export function useSingleFlight(): SingleFlight {
  const flight = useRef<object | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { flight.current = null; }, []);
  const run = useCallback(async <T,>(task: (isCurrent: () => boolean) => Promise<T>): Promise<T | undefined> => {
    if (flight.current) return undefined;
    const lease = {};
    flight.current = lease;
    setBusy(true);
    try {
      return await task(() => flight.current === lease);
    } finally {
      if (flight.current === lease) { flight.current = null; setBusy(false); }
    }
  }, []);
  const release = useCallback(() => {
    if (!flight.current) return;
    flight.current = null;
    setBusy(false);
  }, []);
  return useMemo(() => ({ busy, run, release }), [busy, run, release]);
}
