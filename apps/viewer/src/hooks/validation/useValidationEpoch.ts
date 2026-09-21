/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-call supersession guard for a long-running validation run (#2802),
 * shared by `useIDS.runValidation` and `useInformationValidation.run`
 * (#5138 PR 4): a re-run issued while a previous one is still in flight must
 * make every write the OLDER call makes after its next `await` — progress,
 * the landed report, a caught error, the `finally` loading-flag reset — a
 * no-op, so the newer call's result is never clobbered and an aborted/older
 * run can never resurrect a report the user already moved past.
 *
 * `bump()` returns the epoch the caller's OWN run should capture and check
 * against `stillWanted` after every `await`.
 */

import { useCallback, useRef } from 'react';

export interface ValidationEpoch {
  /** Start a new run (or invalidate the current one on clear/cancel);
   *  returns the epoch this call now owns. */
  bump: () => number;
  /** True while `epoch` is still the most recent one `bump()` handed out. */
  stillWanted: (epoch: number) => boolean;
}

export function useValidationEpoch(): ValidationEpoch {
  const epochRef = useRef(0);
  const bump = useCallback((): number => ++epochRef.current, []);
  const stillWanted = useCallback((epoch: number): boolean => epochRef.current === epoch, []);
  return { bump, stillWanted };
}
