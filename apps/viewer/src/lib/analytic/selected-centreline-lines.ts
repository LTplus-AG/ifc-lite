/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FederatedModel, ViewerState } from '@/store';
import { findReferenceSpatialModel, extractModelSpatialPlacement } from '@/hooks/ingest/federationAlign';
import { applyAffineTransform } from '@/hooks/ingest/federationAlignAabb';
import { buildCrossCrsPointMap, buildSpatialAlignmentTransform } from '@/hooks/ingest/federationSpatialTransform';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { directrixDisplayLines, type FederationPointMap } from './directrix-frame';
import { directrixLineVertices } from './directrix-lines';
import type { SelectedSweptDisk } from '@/hooks/useSelectedSweptDisks';
import type { SelectedDirectrixSegment } from './segment-selection';

const MAX_DISPLAY_EDGES = 100_000;

export function sourceOccurrenceKey(modelId: string, expressId: number, occurrenceIndex: number): string {
  return `${modelId}\u0000${expressId}\u0000${occurrenceIndex}`;
}

/** Source-frame point mapping follows the same alignment chosen for the mesh. */
export async function modelFrameMap(model: FederatedModel, state: ViewerState): Promise<FederationPointMap | undefined> {
  const status = model.federationAlignmentStatus;
  if (status !== 'same-crs' && status !== 'reprojected') return undefined;
  const sourceInfo = model.preAlignment?.coordinateInfo;
  const anchor = findReferenceSpatialModel();
  if (!sourceInfo || !anchor || !model.ifcDataStore) {
    throw new Error(`model ${model.id} has no source or reference frame for ${status} alignment`);
  }
  const source = extractModelSpatialPlacement(
    model.ifcDataStore, sourceInfo, state.georefMutations.get(model.id),
  );
  if (!source) throw new Error(`model ${model.id} has no valid source georeference`);
  if (status === 'same-crs') {
    const affine = buildSpatialAlignmentTransform(source, anchor.placement);
    if (!affine) throw new Error(`model ${model.id} cannot map its selected directrix into the anchor frame`);
    return (x, y, z) => applyAffineTransform(affine, x, y, z);
  }
  const reprojection = await buildCrossCrsPointMap(source, anchor.placement);
  if (!reprojection) throw new Error(`model ${model.id} cannot reproject its selected directrix`);
  return reprojection.map;
}

/** Exact source curves remain untouched; only this bounded display copy is tessellated. */
export async function selectedCentrelineWorldLines(
  items: readonly SelectedSweptDisk[], state: ViewerState,
  highlight: SelectedDirectrixSegment | null = null,
): Promise<{ vertices: number[]; diagnostics: string[]; renderedOccurrences: Set<string> }> {
  const vertices: number[] = [];
  const diagnostics: string[] = [];
  const renderedOccurrences = new Set<string>();
  const maps = new Map<string, FederationPointMap | undefined>();
  let remaining = MAX_DISPLAY_EDGES;
  for (const item of items) {
    const { modelId, expressId } = item.ref;
    if (highlight && (modelId !== highlight.modelId || expressId !== highlight.expressId)) continue;
    const model = state.models.get(modelId);
    const legacy = modelId === 'legacy' && state.models.size === 0;
    const geometry = model?.geometryResult ?? (legacy ? state.geometryResult : null);
    if (!geometry || (model && !model.visible)) continue;
    for (const message of item.diagnostics) diagnostics.push(message);
    const sourceFrame = model?.preAlignment?.coordinateInfo ?? geometry.coordinateInfo;
    const placed = placementFor(state.modelPlacement, modelId);
    const placement = { ...placed, translation: displayedTranslation(state.modelPlacement, modelId) };
    let map: FederationPointMap | undefined;
    try {
      if (!maps.has(modelId)) maps.set(modelId, model ? await modelFrameMap(model, state) : undefined);
      map = maps.get(modelId);
    } catch (error) {
      diagnostics.push(`${modelId} #${expressId}: ${String(error)}`);
      continue;
    }
    for (const [occurrenceIndex, occurrence] of item.occurrences.entries()) {
      if (highlight && highlight.occurrenceIndex !== occurrenceIndex) continue;
      if (occurrence.status.type === 'unsupported') {
        diagnostics.push(`${modelId} #${expressId} solid #${occurrence.solid_id}: unsupported source (${occurrence.status.reason})`);
        continue;
      }
      if (occurrence.source_modified) {
        diagnostics.push(`${modelId} #${expressId} solid #${occurrence.solid_id}: CSG-modified analytic source does not describe the visible solid`);
        continue;
      }
      try {
        const directrix = highlight
          ? occurrence.Directrix.slice(highlight.segmentIndex, highlight.segmentIndex + 1)
          : occurrence.Directrix;
        const lines = directrixLineVertices(directrix, remaining);
        const displayLines = directrixDisplayLines(lines, sourceFrame, placement, map);
        remaining -= lines.length / 6;
        for (const coordinate of displayLines) vertices.push(coordinate);
        if (displayLines.length > 0) renderedOccurrences.add(sourceOccurrenceKey(modelId, expressId, occurrenceIndex));
      } catch (error) {
        diagnostics.push(`${modelId} #${expressId} solid #${occurrence.solid_id}: ${String(error)}`);
      }
    }
  }
  return { vertices, diagnostics, renderedOccurrences };
}
