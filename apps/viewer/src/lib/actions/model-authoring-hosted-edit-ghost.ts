/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { StoreEditor } from '@ifc-lite/mutations';
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { elementStoreyId, buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { HOSTED_SLIDE, readHostedSlide } from '@/lib/commands/modeling/commands/hosted-slide';
import { writeHostedEdit } from './model-authoring-hosted-edit';
import type { AuthoringRow } from './model-authoring-preview';
import type { ModelAuthoringBatch } from './model-authoring';

/** #7265: the existing native slide ghost draws the post-edit cut bounds on
 * an unpublished draft. It never claims a filling solid or detailed cut mesh. */
export function authoringHostedEditGhost(state: ViewerState, batch: ModelAuthoringBatch, row: AuthoringRow, id: number, rows: readonly AuthoringRow[]): MeshData | null {
  // This existing command ghost reads one source draft; it does not compose
  // prior geometry operations. Report that boundary rather than draw stale bounds.
  if (rows.some(prior => prior.index < row.index && prior.status === 'ready' && prior.modelId === row.modelId
    && prior.op.op !== 'type.assign' && prior.op.op !== 'material.assign')) return null;
  if (row.op.op !== 'hosted.edit' || !row.modelId || row.resolved.target === undefined) return null;
  const modelId = row.modelId, expressId = row.resolved.target, op = row.op;
  const source = state.models.get(modelId)?.ifcDataStore, view = state.mutationViews.get(modelId);
  if (!source || !view) return null;
  return view.prepareAtomic(draft => {
    const editor = new StoreEditor(source, draft);
    const read = writeHostedEdit(batch, source, editor, expressId, op.expected, op.edit, op.target.globalId);
    const derived: ViewerState = { ...state, mutationViews: new Map([...state.mutationViews, [modelId, draft]]),
      storeEditors: new Map([...state.storeEditors, [modelId, editor]]) };
    const storeyId = elementStoreyId(derived, modelId, read.hostId);
    const plane = storeyId === null ? null : buildStoreyWorkplane(derived, modelId, storeyId, 0);
    if (!plane || !isWorkplane(plane)) return null;
    const target = readHostedSlide(derived, modelId, expressId);
    if (!target) return null;
    const mesh = HOSTED_SLIDE.ghost?.({ target, offset: read.offset }, { get: () => derived, modelId, storeyId, workplane: plane })?.[0];
    return mesh ? { ...mesh, expressId: id } : null;
  }).result;
}
