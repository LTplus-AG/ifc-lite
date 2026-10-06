/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * React binding for `lib/result/selection-model.ts`: the reducer plus the one
 * asynchronous step, retrieving the authoritative keys of the whole matching
 * population for "Select all matching".
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { EMPTY_SELECTION, reduceSelection, type ResultSelection, type SelectionAction } from '@/lib/result/selection-model';

export interface ResultSelectionControls {
  state: ResultSelection;
  dispatch: (action: SelectionAction) => void;
  /** Ask the source for every matching key; resolves the selection when it answers. */
  selectPopulation: () => void;
}

interface Options {
  /** Size of the matching population as the engine reports it. */
  populationTotal: number;
  /** Authoritative keys of the whole matching population (may page through a worker). */
  resolvePopulation: () => Promise<readonly string[]>;
  /** Changes whenever the filtered population changes (a filter key, a result id). */
  populationKey: unknown;
}

export function useResultSelection({ populationTotal, resolvePopulation, populationKey }: Options): ResultSelectionControls {
  const [state, dispatch] = useReducer(reduceSelection, EMPTY_SELECTION);
  const requests = useRef(state.requests);
  requests.current = state.requests;

  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    dispatch({ type: 'populationChanged' });
  }, [populationKey]);

  const selectPopulation = useCallback(() => {
    const request = requests.current + 1;
    dispatch({ type: 'requestPopulation', total: populationTotal });
    resolvePopulation().then(
      (keys) => dispatch({ type: 'populationResolved', request, keys }),
      (error: unknown) => {
        console.warn('[result selection] Could not retrieve the matching population', error);
        dispatch({ type: 'populationFailed', request });
      },
    );
  }, [populationTotal, resolvePopulation]);

  return { state, dispatch, selectPopulation };
}
