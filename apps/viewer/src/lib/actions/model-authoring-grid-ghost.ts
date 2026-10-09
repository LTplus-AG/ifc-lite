/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { StoreEditor } from '@ifc-lite/mutations';
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { storeyAuthoringFrame } from '@/lib/authoring/storey-authoring-frame';
import { gridAxesGhost } from '@/lib/commands/modeling/commands/grid-place-geometry';
import { authoringReader } from './model-authoring-read';
import { nativeGridExpected, writeGridCreation } from './model-authoring-grid-native';
import { authoredCreationGhost } from './model-authoring-ghost';
import { gridColumnParamsInMetres } from './model-authoring-grid-fields';
import type { ModelAuthoringBatch } from './model-authoring';
import type { AuthoringRow } from './model-authoring-preview';

/** Current saved workplanes only: native edits may be applicable while their live frame preview is unavailable. */
export function gridCreationGhost(state: ViewerState, batch: ModelAuthoringBatch, row: AuthoringRow, id: number): MeshData[] {
  if ((row.op.op !== 'grid.create' && row.op.op !== 'column.createOnGrid') || row.modelId === null || row.resolved.storey === undefined) return [];
  const r = authoringReader(state, row.modelId);
  if (!r) return [];
  const storey = row.resolved.storey;
  // buildStoreyWorkplane currently reads the saved placement plan. Do not draw it
  // as the live native edit frame when effective placement edits differ (#7304).
  const saved = storeyAuthoringFrame(r.dataStore, storey, undefined);
  const current = storeyAuthoringFrame(r.dataStore, storey, r.view);
  if (JSON.stringify(saved) !== JSON.stringify(current)) return [];
  const plane = buildStoreyWorkplane(state, row.modelId, storey, 0);
  if (!isWorkplane(plane)) return [];
  const op = row.op;
  if (op.op === 'column.createOnGrid') {
    const params = gridColumnParamsInMetres(op.params, batch.units);
    // The shared ordinary column ghost is centred on storey +X. Other explicit
    // section headings are native-applicable but must not be drawn unturned.
    if (params.RefDirection && (params.RefDirection[0] <= 0 || params.RefDirection[1] !== 0)) return [];
    const mesh = authoredCreationGhost(plane, { kind: 'column', params }, id);
    return mesh ? [mesh] : [];
  }
  return r.view.prepareAtomic(view => {
    const editor = new StoreEditor(r.dataStore, view);
    const gridId = writeGridCreation(r.dataStore, editor, batch, op, storey, undefined, new Map());
    const expected = nativeGridExpected({ ...r, editor, view }, gridId, storey);
    return expected ? gridAxesGhost(plane, expected.axes, expected.frame.o[2], id) : [];
  }).result;
}
