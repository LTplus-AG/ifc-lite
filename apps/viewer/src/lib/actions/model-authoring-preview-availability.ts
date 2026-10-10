/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { authoringCurtainWallGhost } from './model-authoring-curtain-wall-ghost';
import { gridCreationGhost } from './model-authoring-grid-ghost';
import { authoringSlabOpeningGhost } from './model-authoring-slab-opening-ghost';
import { stairRailingGhost } from './model-authoring-stair-railing-ghost';
import { authoringHostedEditGhost } from './model-authoring-hosted-edit-ghost';
import { authoringSplitMarker } from './model-authoring-split-ghost';
import { authoringSizeGhost } from './model-authoring-size-ghost';
import type { ViewerState } from '@/store';
import type { ModelAuthoringBatch } from './model-authoring';
import type { AuthoringRow } from './model-authoring-preview-types';

/** Compute native ghost availability only after the complete draft is validated. */
export function updateAuthoringPreviewAvailability(state: ViewerState, batch: ModelAuthoringBatch, rows: AuthoringRow[]): void {
  for (const row of rows) if (row.status === 'ready' && row.modelId && (row.op.op === 'element.resize' || row.op.op === 'element.profile' || row.op.op === 'element.trimExtend' || (row.op.op === 'material.layers' && row.op.scope === 'element' && row.resolved.layers?.kind === 'wall'))) {
    const boundary = row.op.op === 'element.trimExtend' ? row.resolved.reachBoundary : undefined;
    // The whole native batch validates this boundary; the independent body draft
    // cannot reproduce a preceding edit of the same existing wall (#7262).
    if (boundary && 'id' in boundary && rows.some(previous => previous.index < row.index
      && previous.status === 'ready' && previous.modelId === row.modelId && previous.expressId === boundary.id
      && previous.op.op !== 'element.copy' && previous.op.op !== 'element.array')) {
      row.previewUnavailable = true;
      continue;
    }
    const ghost = authoringSizeGhost(state, batch, row, row.modelId, 0);
    row.previewUnavailable = ghost.unavailable;
    row.previewOmitted = ghost.omitted;
    row.previewOuterBodyOnly = ghost.outerBodyOnly;
  }
  for (const row of rows) if (row.status === 'ready' && row.op.op === 'hosted.edit') row.previewUnavailable = authoringHostedEditGhost(state, batch, row, 0, rows) === null;
  for (const row of rows) if (row.status === 'ready' && row.op.op === 'element.split') {
    row.previewUnavailable = authoringSplitMarker(state, batch, row, 0) === null;
  }
  for(const row of rows)if(row.status==='ready'&&row.op.op==='hosted.create'&&'params' in row.op)row.previewUnavailable=!authoringSlabOpeningGhost(state,row,rows,0);
  for(const row of rows)if(row.status==='ready'&&['stair.create','railing.create','stair.replace','railing.replace'].includes(row.op.op))row.previewUnavailable=!stairRailingGhost(state,batch,row,0);
  for (const row of rows) if (row.status === 'ready' && row.op.op === 'curtainWall.create') row.previewUnavailable = authoringCurtainWallGhost(state, batch, row, 0).length === 0;
  for (const row of rows) if (row.status === 'ready' && (row.op.op === 'grid.create' || row.op.op === 'column.createOnGrid')) row.previewUnavailable = gridCreationGhost(state, batch, row, 0).length === 0;
}
