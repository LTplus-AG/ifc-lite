/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useOverlayChannelGate } from '@/hooks/useOverlayChannelGate';
import { storeyGridAxes } from '@/lib/snap/sources/ifc-grid-store';
import type { GridAxisSegment } from '@ifc-lite/create';

/** File and authored axes in the active storey's local metres, kept current
 * through edits, Undo/Redo and reload. Grid visibility uses the same class
 * gate as the 3D overlay and canonical model-qualified entity hides. */
export function usePlanGridAxes(): readonly GridAxisSegment[] {
  const session = useViewerStore((s) => s.session);
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const visible = useViewerStore((s) => s.typeVisibility.ifcGrid);
  const { grid } = useOverlayChannelGate(false, visible);
  return useMemo(() => {
    void mutationVersion;
    if (!grid || !session || session.storeyId === null) return [];
    const model = models.get(session.modelId);
    const view = useViewerStore.getState().mutationViews.get(session.modelId);
    if (!model?.ifcDataStore || !view || !model.visible) return [];
    const hidden = (id: number) => hiddenEntities.has(toGlobalIdFromModels(models, session.modelId, id));
    return storeyGridAxes(model.ifcDataStore, view, session.storeyId)
      .filter((axis) => !hidden(axis.gridId) && !hidden(axis.axisId));
  }, [session?.modelId, session?.storeyId, models, mutationVersion, hiddenEntities, grid]);
}
