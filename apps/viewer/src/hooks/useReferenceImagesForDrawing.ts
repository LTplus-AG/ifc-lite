/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useState } from 'react';
import type { SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { referenceDrawingCorners, type DrawingReferenceImage } from '@/lib/appearance/references/drawing';

/** Each canvas owns a lease until unmount/replacement; shared ImageBitmaps must
 * never be closed by the canvas. Removed/hidden records disappear synchronously
 * even while a previous decode is finishing. */
export function useReferenceImagesForDrawing(plane: SectionPlaneConfig): readonly DrawingReferenceImage[] {
  const references = useViewerStore(state => state.appearanceReferences);
  const revision = useViewerStore(state => state.referenceRevision);
  const models = useViewerStore(state => state.models);
  const geometry = useViewerStore(state => state.geometryResult);
  const placement = useViewerStore(state => state.modelPlacement);
  const anchor = useViewerStore(state => state.anchorModelIdOverride);
  const mutations = useViewerStore(state => state.georefMutations);
  const [decoded, setDecoded] = useState<ReadonlyMap<string, ImageBitmap>>(new Map());
  useEffect(() => {
    const controller = new AbortController();
    const owner = { kind: 'draft' as const, id: `reference-canvas:${crypto.randomUUID()}` };
    setDecoded(new Map());
    void (async () => {
      for (const record of references.values()) {
        if (controller.signal.aborted) return;
        if (!record.visible || record.opacity <= 0 || !appearanceAssets.get(record.assetId)) continue;
        try {
          appearanceAssets.retain(record.assetId, owner);
          const image = await appearanceAssets.decode(record.assetId, owner, controller.signal);
          if (!controller.signal.aborted) setDecoded(previous => new Map(previous).set(record.assetId, image));
        } catch (error) {
          if (!controller.signal.aborted) console.warn('[Drawing references] Could not decode image:', error);
        }
      }
    })();
    return () => { controller.abort(); appearanceAssets.releaseOwner(owner); };
  }, [references, revision]);
  return useMemo(() => {
    const state = useViewerStore.getState();
    return [...references.values()].flatMap(record => {
      const image = decoded.get(record.assetId), corners = referenceDrawingCorners(record, state, plane);
      return image && corners ? [{ id: record.id, image, corners, opacity: record.opacity }] : [];
    });
  }, [references, decoded, plane, models, geometry, placement, anchor, mutations]);
}
