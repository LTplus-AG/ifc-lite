/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useReducer, useRef } from 'react';

/** A recovery observed during an outstanding finalizer is consumed once its
 * real rejection arrives. Failure without a newer recovery never polls/retries.
 */
export function useFinalizationRecoveryWake(epoch: number): readonly [number, (attemptEpoch: number) => void] {
  const latestEpoch = useRef(epoch);
  latestEpoch.current = epoch;
  const [version, wake] = useReducer((value: number) => value + 1, 0);
  const afterFailure = useCallback((attemptEpoch: number) => {
    if (latestEpoch.current !== attemptEpoch) wake();
  }, []);
  return [version, afterFailure];
}
