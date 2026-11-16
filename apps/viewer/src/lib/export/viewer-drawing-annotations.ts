/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { totalYupOffset, viewerToIfcAxes } from '@/lib/geo/coordinate-frame';
import type { IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { absorbedEmbeddedMarkupFor } from '@/lib/drawing2d-markup/drawing-markup-absorbed';
import { useViewerStore } from '@/store';
import { resolveElementTagLabel } from '@/lib/drawing/element-tags';
import { dimensionPaperScale } from '@/lib/drawing2d-markup/dimension-markup-save';
import { prepareDrawingAnnotations } from './drawing-annotations';

/** Only the active drawing owns the flat markup arrays. Never copy it to a federation peer. */
export function viewerDrawingAnnotations(modelId: string, store: IfcDataStore, view: MutablePropertyView | undefined, toSourceId: (id: number) => number | undefined = id => id) {
  const state = useViewerStore.getState();
  const owner = state.activeModelId ?? (state.models.size === 0 ? '__legacy__' : null);
  if (modelId !== owner) return view;
  const plane = state.drawing2DPlane;
  if (!plane) return view;
  const storeyId = state.activeStorey?.modelId === modelId ? toSourceId(state.activeStorey.expressId)
    : iterateEffectiveEntityIds(store, view, ['IFCBUILDINGSTOREY']).next().value?.expressId;
  if (!storeyId) return view;
  const offset = viewerToIfcAxes(totalYupOffset(state.models.get(modelId)?.geometryResult?.coordinateInfo ?? state.geometryResult?.coordinateInfo));
  return prepareDrawingAnnotations(store, view, {
    absorbed: absorbedEmbeddedMarkupFor(modelId),
    ifcOffset: [offset.x, offset.y, offset.z],
    measures: state.measure2DResults, dimensions: state.dimensions2D,
    tags: state.tagAnnotations2D.filter(tag => tag.modelId === modelId).flatMap(tag => {
      const entityId = toSourceId(tag.entityId);
      if (entityId === undefined) return [];
      const label = resolveElementTagLabel(tag);
      return label === null ? [] : [{ tag: { ...tag, entityId }, label }];
    }),
    plane, storeyId, paperScale: dimensionPaperScale(state),
  });
}
