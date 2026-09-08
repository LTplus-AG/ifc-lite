/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D preview isolation for the anonymized-export dialog (#2934).
 *
 * Captures the viewer's prior `{isolated, ghostExcept, hidden}` view ONCE on
 * enable, then keeps `isolatedEntities` in sync with the export's `includedIds`
 * (converted to the renderer's global-id space via `toGlobalIdForRef` — never
 * offset arithmetic) on every change while the preview is on. Restores the
 * captured view on disable, close, or unmount, guarded so it only ever fires
 * once per enable. Pattern copied from
 * `components/viewer/tools/space-sketch/useSpaceSceneFraming.ts`.
 *
 * Deliberately uses `setIsolatedEntities`, never `isolateEntities`: the
 * latter TOGGLES off when called twice with the same set, which would fight
 * this hook's own re-application on every `includedIds` change.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useViewerStore, toGlobalIdForRef } from '@/store';

interface PriorView {
  isolated: Set<number> | null;
  ghostExcept: Set<number> | null;
  hidden: Set<number>;
  /** Renderer highlight channel (`selectedEntityIds` / `selectedEntityId`),
   *  driven to the included set while previewing so the objects about to be
   *  exported read as highlighted, not merely as "the only ones visible". */
  selectedIds: number[];
  selectedId: number | null;
}

interface UsePreviewIsolationArgs {
  /** Preview toggle ON and the owning dialog open. */
  enabled: boolean;
  /** The model `includedIds` are local express ids within. */
  targetModelId: string | null;
  includedIds: ReadonlySet<number>;
}

export function usePreviewIsolation({ enabled, targetModelId, includedIds }: UsePreviewIsolationArgs): void {
  const priorRef = useRef<PriorView | null>(null);
  const restoredRef = useRef(true);

  const restore = useCallback(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const prior = priorRef.current;
    priorRef.current = null;
    if (prior) {
      const store = useViewerStore.getState();
      store.restoreVisibilityState(prior);
      store.setSelectedEntityIds(prior.selectedIds);
      store.setSelectedEntityId(prior.selectedId);
    }
  }, []);

  // Capture the prior view exactly once per enable transition; the cleanup
  // (disable or unmount) restores it.
  useEffect(() => {
    if (!enabled) return;
    const store = useViewerStore.getState();
    restoredRef.current = false;
    priorRef.current = {
      isolated: store.isolatedEntities ? new Set(store.isolatedEntities) : null,
      ghostExcept: store.ghostExceptEntities ? new Set(store.ghostExceptEntities) : null,
      hidden: new Set(store.hiddenEntities),
      selectedIds: [...store.selectedEntityIds],
      selectedId: store.selectedEntityId,
    };
    return () => restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot capture on the enable transition, like useSpaceSceneFraming
  }, [enabled, restore]);

  // Re-apply the isolated set whenever the included set changes, while enabled.
  useEffect(() => {
    if (!enabled || !targetModelId) return;
    const store = useViewerStore.getState();
    const globalIds = new Set<number>();
    for (const id of includedIds) {
      globalIds.add(toGlobalIdForRef(store.models, { modelId: targetModelId, expressId: id }));
    }
    store.setIsolatedEntities(globalIds);
    // Highlight the same set. Seeds are latched by `useAnonymizedExportSet`
    // on open, so rewriting the live selection here does not re-seed.
    store.setSelectedEntityIds([...globalIds]);
  }, [enabled, targetModelId, includedIds]);
}
