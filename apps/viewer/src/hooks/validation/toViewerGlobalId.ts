/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `(modelId, expressId) -> renderer global id`, shared by every report-driven
 * hook (#5138 PR 4 split of `useIDS.ts`: `useValidationColorFocus.ts` and
 * `useValidationIsolation.ts` both need it). Pulled out rather than
 * duplicated so the legacy-mode fallback (single-model/pre-federation
 * sessions, where `globalId === expressId`) stays in exactly one place.
 */

import { useCallback } from 'react';
import { useViewerStore } from '@/store';

export function useToViewerGlobalId(): (modelId: string, expressId: number) => number | undefined {
  const models = useViewerStore((s) => s.models);
  const toGlobalId = useViewerStore((s) => s.toGlobalId);

  return useCallback((modelId: string, expressId: number): number | undefined => {
    if (
      modelId === '__legacy__'
      || modelId === 'legacy'
      || models.size === 0
      || (models.size === 1 && !models.has(modelId))
    ) {
      return expressId;
    }
    if (!models.has(modelId)) return undefined;
    return toGlobalId(modelId, expressId);
  }, [models, toGlobalId]);
}
