/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { restoreWorkspacePlacements, saveWorkspacePlacements, placementFrameKey } from '@/lib/model-placement/persistence';
import type { ModelPlacement } from '@/lib/model-placement/state';

export function useModelPlacementPersistence(): void {
  // Object identity distinguishes an automatic restore from a later explicit
  // move, lock, reset or import, including an edit subsequently undone.
  const automatic = useRef(new Map<string, ModelPlacement>());
  const restoring = useRef(false);
  const models = useViewerStore((state) => state.models);
  const anchor = useViewerStore((state) => state.anchorModelIdOverride);
  useEffect(() => {
    try {
      const state = useViewerStore.getState();
      const counts = new Map<string, number>();
      for (const model of state.models.values()) {
        if (model.sourceContentHash) counts.set(model.sourceContentHash, (counts.get(model.sourceContentHash) ?? 0) + 1);
      }
      const revoked = new Set<string>();
      for (const [id, placement] of automatic.current) {
        const fingerprint = state.models.get(id)?.sourceContentHash;
        if (state.modelPlacement.placements.get(id) !== placement || !fingerprint) automatic.current.delete(id);
        else if (counts.get(fingerprint) !== 1) { revoked.add(id); automatic.current.delete(id); }
      }
      const restored = restoreWorkspacePlacements(localStorage, state);
      if (restored.size === 0 && revoked.size === 0) return;
      const placements = new Map([...state.modelPlacement.placements, ...restored]);
      for (const id of revoked) placements.delete(id);
      for (const [id, placement] of restored) automatic.current.set(id, placement);
      const preview = state.modelPlacement.preview;
      const cancelPreview = preview && (preview.modelIds.some((id) => revoked.has(id)) ||
        (preview.target && revoked.has(preview.target.modelId)));
      restoring.current = true;
      try {
        useViewerStore.setState({ modelPlacement: { ...state.modelPlacement,
          frameKey: placementFrameKey(state), placements, preview: cancelPreview ? null : preview,
          revision: state.modelPlacement.revision + 1 }, ...(cancelPreview ? { repositionOpen: false } : {}) });
      } finally { restoring.current = false; }
    } catch (error) {
      console.warn('[Reposition] Placement restore failed:', error);
      toast.error('Saved model placements could not be restored. You can import a placement manifest.');
    }
  }, [models, anchor]);

  useEffect(() => useViewerStore.subscribe((state, previous) => {
    // Restoration must not rewrite the saved source record (especially while
    // duplicate instances make automatic binding ambiguous).
    if (restoring.current) return;
    for (const [id, placement] of automatic.current) {
      if (state.modelPlacement.placements.get(id) !== placement) automatic.current.delete(id);
    }
    if (!state.models.size || state.models !== previous.models ||
      (state.modelPlacement.placements === previous.modelPlacement.placements && state.modelPlacement.frameKey === previous.modelPlacement.frameKey)) return;
    try { saveWorkspacePlacements(localStorage, state); }
    catch (error) {
      console.warn('[Reposition] Placement persistence failed:', error);
      toast.error('Model placement is active but could not be saved. Export a placement manifest to keep it.');
    }
  }), []);
}
