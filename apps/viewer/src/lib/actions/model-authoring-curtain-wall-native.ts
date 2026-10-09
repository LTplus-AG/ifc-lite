/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { addCurtainWallToStore, resolveSpatialAnchor } from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { ensureStoreyPlacement } from '@/store/slices/storeyPlacement';
import type { AuthoringOp, ModelAuthoringBatch } from './model-authoring';
import { curtainWallParamsInMetres } from './model-authoring-curtain-wall-fields';
import { uniqueSplitGuids } from './model-authoring-split';
/** Dry-run and commit invoke the same native aggregate builder and complete Root identity check. */
export function writeCurtainWallCreation(store: IfcDataStore, editor: StoreEditor, batch: ModelAuthoringBatch, op: Extract<AuthoringOp, { op: 'curtainWall.create' }>, storey: number) {
  ensureStoreyPlacement(store, editor, storey);
  const made = addCurtainWallToStore(editor, resolveSpatialAnchor(store, storey, editor.getMutationView()), curtainWallParamsInMetres(op.params, batch.units));
  const guids = [made.curtainWallId, ...made.mullionIds, ...made.transomIds, ...made.panelIds].map(id => {
    const guid = editor.getMutationView().getNewEntity(id)?.attributes[0];
    if (typeof guid !== 'string') throw new Error('A native curtain-wall Root has no GlobalId');
    return guid;
  });
  if (!uniqueSplitGuids(store, editor, guids)) throw new Error('A native curtain-wall Root GlobalId is not unique in its owning model');
  return made;
}
