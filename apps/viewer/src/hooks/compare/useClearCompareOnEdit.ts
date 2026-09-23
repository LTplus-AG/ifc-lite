/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Retire a published comparison and its cached fingerprints when the user
 * edits any model (#5312).
 *
 * Compare fingerprints each model as edited (`effectiveCompareStore`). An edit
 * made after the run makes that result describe a model that no longer
 * exists. A result left on screen would silently disagree with the model tree
 * and the Properties panel, which is the Compare-vs-viewer disagreement #5214
 * reported, just delayed. `mutationVersion` is the scalar every edit action
 * bumps, so it is the edit signal. Same treatment as a federation re-alignment
 * (`geometryContentVersion`): clear the result and drop the cache, and the next
 * run re-extracts. The fingerprint cache itself is also keyed on the version
 * (`isCurrentFor`), so a run in flight across an edit re-extracts instead of
 * publishing the pre-edit answer.
 */

import { useEffect, type MutableRefObject } from 'react';
import { useViewerStore } from '@/store';

export function useClearCompareOnEdit(
  builtRef: MutableRefObject<unknown>,
  clearCompare: () => void,
): void {
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const result = useViewerStore((s) => s.compareResult);
  // Compared against the version the RESULT was computed at, not a value seen
  // at mount: an edit made while the Compare panel was closed must still
  // retire the result it left in the store.
  useEffect(() => {
    if (!result || result.mutationVersion === undefined || result.mutationVersion === mutationVersion) return;
    builtRef.current = null;
    clearCompare();
  }, [mutationVersion, result, builtRef, clearCompare]);
}
