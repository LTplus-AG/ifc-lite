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
 * run re-extracts. Clearing also bumps the run epoch, so a run in flight when
 * the edit lands publishes nothing.
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import { useViewerStore } from '@/store';

export function useClearCompareOnEdit(
  builtRef: MutableRefObject<unknown>,
  clearCompare: () => void,
): void {
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  // Seeded with the mounted value so a remount is not mistaken for an edit.
  const lastRef = useRef(mutationVersion);
  useEffect(() => {
    if (lastRef.current === mutationVersion) return;
    lastRef.current = mutationVersion;
    builtRef.current = null;
    clearCompare();
  }, [mutationVersion, builtRef, clearCompare]);
}
