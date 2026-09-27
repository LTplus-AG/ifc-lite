/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Retire cached fingerprints when the user edits any model (#5820).
 *
 * Compare fingerprints each model as edited (`effectiveCompareStore`). An edit
 * made after the run leaves its result stale. Keep the result visible with the
 * shared banner, but drop the cache so an option change cannot re-diff stale
 * fingerprints. The next run re-extracts.
 */

import { useEffect, type MutableRefObject } from 'react';
import { useViewerStore } from '@/store';

export function useInvalidateCompareCacheOnEdit(builtRef: MutableRefObject<unknown>): void {
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const result = useViewerStore((s) => s.compareResult);
  // Compare against the result's version so an edit while the panel was closed
  // also invalidates its cache on remount.
  useEffect(() => {
    if (!result || result.mutationVersion === undefined || result.mutationVersion === mutationVersion) return;
    builtRef.current = null;
  }, [mutationVersion, result, builtRef]);
}
