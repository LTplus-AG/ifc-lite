/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keeps the `grids` authoring overlay channel in step with the grids authored
 * this session (`lib/grids/authored-grid-meshes.ts`): redrawn on every edit
 * and every loaded-model change, cleared on unmount. Mounted once, with the
 * viewport container.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { authoredGridMeshes, gridMeshesKey } from '@/lib/grids/authored-grid-meshes';
import { useOverlayChannelGate } from '@/hooks/useOverlayChannelGate';

export function useAuthoredGridOverlay(): void {
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const models = useViewerStore((s) => s.models);
  const modelPlacement = useViewerStore((s) => s.modelPlacement);
  const gridVisible = useViewerStore((s) => s.typeVisibility.ifcGrid);
  // File axes and authored strips obey the same global/embedding-host gate.
  const { grid } = useOverlayChannelGate(false, gridVisible);
  // The viewport registers its overlay upload once its renderer is up.
  const setOverlay = useViewerStore((s) => s.cameraCallbacks.setAuthoringOverlayMeshes);
  // An edit that leaves the grids as they were (most of them) must not re-upload the
  // strips and drop the pick caches: redraw only when their geometry changed.
  const drawn = useRef<{ upload: typeof setOverlay; key: string } | null>(null);
  useEffect(() => {
    if (!setOverlay) return;
    const meshes = grid ? authoredGridMeshes(useViewerStore.getState()) : [];
    const key = gridMeshesKey(meshes);
    // A new upload function is a new renderer: it has drawn nothing yet.
    if (drawn.current?.upload === setOverlay && drawn.current.key === key) return;
    drawn.current = { upload: setOverlay, key };
    setOverlay('grids', meshes);
  }, [mutationVersion, models, modelPlacement, setOverlay, grid]);
  useEffect(() => () => {
    drawn.current = null;
    useViewerStore.getState().cameraCallbacks.clearAuthoringOverlayMeshes?.('grids');
  }, []);
}
