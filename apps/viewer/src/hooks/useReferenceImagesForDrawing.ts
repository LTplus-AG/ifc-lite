/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useMemo, useState } from 'react';
import type { Drawing2D, SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { referenceDrawingCorners, drawingWithReferenceBounds, type DrawingReferenceImage } from '@/lib/appearance/references/drawing';

function useProjectedReferences(plane: SectionPlaneConfig | undefined) {
  const references = useViewerStore(state => state.appearanceReferences);
  const revision = useViewerStore(state => state.referenceRevision);
  const models = useViewerStore(state => state.models), geometry = useViewerStore(state => state.geometryResult);
  const placement = useViewerStore(state => state.modelPlacement);
  return useMemo(() => {
    if (!plane) return [];
    const state = useViewerStore.getState();
    return [...references.values()].flatMap(record => {
      const corners = referenceDrawingCorners(record, state, plane);
      return corners && appearanceAssets.get(record.assetId) ? [{record,corners}] : [];
    });
  }, [references, revision, plane, models, geometry, placement]);
}

/** Display bounds only: do not write reference extents into generated geometry
 * or the stored drawing. Fit and sheet layout use this same derived drawing. */
export function useDrawingWithReferences(source: Drawing2D | null) {
  const references = useProjectedReferences(source?.config.plane);
  return useMemo(() => ({ drawing: source ? drawingWithReferenceBounds(source, references.map(r => r.corners)) : null,
    hasReferences: references.length > 0 }), [source, references]);
}

/** Each canvas owns a lease until unmount/replacement; shared ImageBitmaps must
 * never be closed by the canvas. Removed/hidden records disappear synchronously
 * even while a previous decode is finishing. */
export function useReferenceImagesForDrawing(plane: SectionPlaneConfig): readonly DrawingReferenceImage[] {
  const references = useViewerStore(state => state.appearanceReferences);
  const revision = useViewerStore(state => state.referenceRevision);
  const projected = useProjectedReferences(plane);
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
    return projected.flatMap(({record,corners}) => {
      const image = decoded.get(record.assetId);
      return image ? [{ id: record.id, image, corners, opacity: record.opacity }] : [];
    });
  }, [decoded, projected]);
}
