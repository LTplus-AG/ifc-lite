/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewport's hidden / ghost sets with the Model workspace's storey
 * context folded in (charter #6232, D9; `lib/visibility/storey-context.ts`).
 *
 * The "above" set is recomputed only when what it depends on changes: the
 * workspace opening or closing, the session storey or model, the mode, Solo,
 * the loaded models or an edit (a storey elevation, a drawn or moved element).
 * Orbiting, hovering and selecting leave it alone.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import {
  applyStoreyContext,
  drawableEntityIds,
  storeyContextAboveIds,
  type ViewportVisibilitySets,
} from '@/lib/visibility/storey-context';

export function useStoreyContextAbove(): Set<number> | null {
  const workspaceMode = useViewerStore((s) => s.workspaceMode);
  const modelId = useViewerStore((s) => s.session?.modelId ?? null);
  const storeyId = useViewerStore((s) => s.session?.storeyId ?? null);
  const mode = useViewerStore((s) => s.storeyContextMode);
  const soloActive = useViewerStore((s) => s.selectedStoreys.size > 0);
  const models = useViewerStore((s) => s.models);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  return useMemo(() => {
    void [workspaceMode, modelId, storeyId, mode, soloActive, models, mutationViews, mutationVersion];
    return storeyContextAboveIds(useViewerStore.getState());
  }, [workspaceMode, modelId, storeyId, mode, soloActive, models, mutationViews, mutationVersion]);
}

export function useStoreyContextVisibility(user: ViewportVisibilitySets): ViewportVisibilitySets {
  const above = useStoreyContextAbove();
  const mode = useViewerStore((s) => s.storeyContextMode);
  const models = useViewerStore((s) => s.models);
  const { hidden, ghostExcept } = user;
  return useMemo(
    () => applyStoreyContext({ hidden, ghostExcept }, mode, above, () => drawableEntityIds(models)),
    [hidden, ghostExcept, mode, above, models],
  );
}
