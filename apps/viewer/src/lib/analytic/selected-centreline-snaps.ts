/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SourceSnapCurve } from '@ifc-lite/renderer';
import type { ViewerState } from '@/store';
import type { SelectedSweptDisk } from '@/hooks/useSelectedSweptDisks';
import type { SelectedDirectrixSegment } from './segment-selection';
import { directrixPointEvaluator } from './directrix-point';
import { directrixDisplayPoint, type FederationPointMap } from './directrix-frame';
import { modelFrameMap } from './selected-centreline-lines';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';

/** The overlay and magnetic picker consume the same selected source records. */
export async function selectedCentrelineSnapCurves(
  items: readonly SelectedSweptDisk[], state: ViewerState,
  highlight: SelectedDirectrixSegment | null = null,
): Promise<SourceSnapCurve[]> {
  const curves: SourceSnapCurve[] = [];
  const maps = new Map<string, Promise<FederationPointMap | undefined>>();
  for (const item of items) {
    const { modelId, expressId } = item.ref;
    if (highlight && (highlight.modelId !== modelId || highlight.expressId !== expressId)) continue;
    const model = state.models.get(modelId);
    const legacy = modelId === 'legacy' && state.models.size === 0;
    const geometry = model?.geometryResult ?? (legacy ? state.geometryResult : null);
    if (!geometry || (model && !model.visible)) continue;
    const sourceFrame = model?.preAlignment?.coordinateInfo ?? geometry.coordinateInfo;
    const placed = placementFor(state.modelPlacement, modelId);
    const placement = { ...placed, translation: displayedTranslation(state.modelPlacement, modelId) };
    let map: FederationPointMap | undefined;
    try {
      if (!maps.has(modelId)) maps.set(modelId, model ? modelFrameMap(model, state) : Promise.resolve(undefined));
      map = await maps.get(modelId);
    } catch (error) {
      console.warn(`[ifc-lite] Cannot snap ${modelId} #${expressId} source directrix:`, error);
      continue;
    }
    const globalId = legacy ? expressId : state.toGlobalId(modelId, expressId);
    for (const [occurrenceIndex, occurrence] of item.occurrences.entries()) {
      if (occurrence.status.type !== 'complete' || occurrence.source_modified) continue;
      if (highlight && highlight.occurrenceIndex !== occurrenceIndex) continue;
      for (const [segmentIndex, segment] of occurrence.Directrix.entries()) {
        if (highlight && highlight.segmentIndex !== segmentIndex) continue;
        const metric = occurrence.directrix_metrics?.segments.find((entry) => entry.segment_index === segmentIndex);
        if (!metric) continue;
        const sourcePointAt = directrixPointEvaluator(segment);
        let warned = false;
        const pointAt: SourceSnapCurve['pointAt'] = (t) => {
          try {
            const source = sourcePointAt(t);
            const [x, y, z] = directrixDisplayPoint(source, sourceFrame, placement, map);
            return { x, y, z };
          } catch (error) {
            if (!warned) console.warn(`[ifc-lite] Cannot snap ${modelId} #${expressId} segment ${segmentIndex + 1}:`, error);
            warned = true;
            return null;
          }
        };
        try {
          // Reject a source with an unsupported frame now, not in a hover event.
          if (![pointAt(0), pointAt(0.5), pointAt(1)].every((point) => point
            && [point.x, point.y, point.z].every(Number.isFinite))) continue;
        } catch (error) {
          console.warn(`[ifc-lite] Cannot validate ${modelId} #${expressId} segment ${segmentIndex + 1}:`, error);
          continue;
        }
        let bounds: SourceSnapCurve['bounds'];
        if (model?.federationAlignmentStatus !== 'reprojected') {
          const a = pointAt(0), b = pointAt(segment.type === 'arc' ? Math.PI / segment.sweep_angle : 1);
          if (a && b) {
            const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
            const u = { x: a.x - center.x, y: a.y - center.y, z: a.z - center.z };
            let radius = Math.hypot(u.x, u.y, u.z);
            if (segment.type === 'arc') {
              const quarter = pointAt(Math.PI / (2 * segment.sweep_angle));
              if (quarter) radius += Math.hypot(quarter.x - center.x, quarter.y - center.y, quarter.z - center.z);
              else radius = Infinity;
            }
            if (Number.isFinite(radius)) bounds = { center, radius: radius + 1e-8 };
          }
        }
        curves.push({
          identity: {
            modelId, expressId, solidId: occurrence.solid_id, directrixId: occurrence.directrix_id,
            mappingPath: [...occurrence.mapping_path], occurrenceIndex, segmentIndex,
          },
          globalId, kind: segment.type, length: metric.length,
          sweepAngle: segment.type === 'arc' ? segment.sweep_angle : undefined,
          affineDisplayFrame: model?.federationAlignmentStatus !== 'reprojected',
          bounds,
          pointAt,
        });
      }
    }
  }
  return curves;
}
