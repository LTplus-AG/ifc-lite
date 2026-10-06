/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { useSemanticSession } from '@/lib/semantic/session';
import { captureReviewSnapshot, type ReviewSnapshot } from '@/lib/review/collect';

/**
 * The review snapshot, recomputed whenever a native result it reads is
 * replaced or an edit invalidates it. The saved clash baseline lives in
 * browser storage with no change event, so `refresh` re-reads it.
 */
export function useReviewSnapshot(): { snapshot: ReviewSnapshot; refresh: () => void } {
  const [tick, setTick] = useState(0);
  const native = useViewerStore(useShallow(s => [s.clashResult, s.clashRawResult, s.idsValidationReport, s.compareResult,
    s.savedComparisons, s.bcfProject, s.models, s.mutationVersion, s.geometryContentVersion, s.modelPlacement]));
  const semantic = useSemanticSession(useShallow(s => [s.document, s.findings, s.report, s.revisions, s.retrievedAt]));
  // The dependency list is the identity of what the sources read; the snapshot itself is derived data.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const snapshot = useMemo(() => captureReviewSnapshot(), [...native, ...semantic, tick]);
  const refresh = useCallback(() => setTick(value => value + 1), []);
  return { snapshot, refresh };
}
