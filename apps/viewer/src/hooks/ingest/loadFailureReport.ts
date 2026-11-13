/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How ONE `loadFile` call reports a failure. Every failure the user sees goes
 * through `loadFailureReporter` (#5618): the error card, its Retry fixed to
 * this call, and the load's own `onLoadError` (#9497), so a caller such as a
 * federated `addModel` learns THIS load's reason even after another load has
 * rewritten the store's global `error`. A retained-kernel refusal reports
 * itself before any work; `settleKernelRefusal` forwards its message the same way.
 */

import { useViewerStore } from '@/store';
import { showLoadError as reportLoadError } from '@/lib/analytics';

/** Show `message` as this load's failure; `retry` defaults to re-running this load. */
export type LoadFailureReporter = (message: string, code: string, retry?: (() => void) | null) => void;

export function loadFailureReporter(
  file: File,
  activity: { fail(message: string): string },
  retryThisLoad: () => void,
  onLoadError: ((message: string) => void) | undefined,
): LoadFailureReporter {
  return (message, code, retry = retryThisLoad) => {
    const shown = activity.fail(message);
    onLoadError?.(shown);
    const { setError, setLastLoadRetry } = useViewerStore.getState();
    reportLoadError(setError, setLastLoadRetry, shown, code, retry, file);
  };
}

/** Wait out a kernel refusal (already on the error card) and hand its message, if any, to `onLoadError`. */
export async function settleKernelRefusal(
  refused: Promise<string | null>,
  onLoadError: ((message: string) => void) | undefined,
): Promise<void> {
  const refusal = await refused;
  if (refusal) onLoadError?.(refusal);
}
