/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { addGridColumnIn } from '@/store/slices/mutation-grid-column';
import { gridBindingForDraft } from './model-authoring-grid-native';
import { gridParamsInMetres, gridColumnParamsInMetres } from './model-authoring-grid-fields';
import { authoringReader } from './model-authoring-read';


/**
 * Commit of an approved, previewed authoring batch: per model ONE modeling
 * transaction (`runTransaction`, one undo step, all-or-nothing, the wasm
 * re-mesh of everything created, moved or reshaped), written through the
 * store's gated actions and modelling methods, the same writes the Model
 * workspace's tools make. A batch spanning models reverts the models already
 * committed when a later one refuses. The receipt is a `ModelChangeReceipt`
 * of kind `model.authoring`, so the receipt library, the Changes panel list
 * and `undoModelChanges` serve both producers.
 */

import { commitNativeReplacement } from './model-authoring-replacement-commit';
import { writeSlabOpening } from './model-authoring-slab-opening';
import type { StoreApi } from 'zustand';
import { writeReviewedLayers } from './model-authoring-layers';
import { generateIfcGuid } from '@ifc-lite/encoding';
import type { ViewerState } from '@/store';
import { copyElements } from '@/lib/commands/modeling/copy-elements';
import { authoringCopyTransforms, copyRefs } from './model-authoring-copy';
import { writeHostedEdit } from './model-authoring-hosted-edit';
import { hostedFillRefusal } from '@/store/slices/mutation-hosted-fill';
import { authoringSourcesAreCurrent } from './model-authoring-sources';
import { runTransaction } from '@/lib/commands/modeling/transaction';
import type { AuthoringTransaction, CommitResult, ModelingCommand } from '@/lib/commands/modeling/types';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { commitElementAlignment, commitElementTransform, planSelectionTransform } from '@/lib/element-transform/commit';
import { writeNativeSplit } from './model-authoring-split';
import { recordModellingEdit, recordModellingCommit } from '@/store/slices/mutation-modelling-records';
import { toMetres, type AuthoringOp, type ModelAuthoringBatch } from './model-authoring';
import { authoredElementOf, hostedSpecOf, idOf, writeRelation, writeNativeTypeDetach } from './model-authoring-native';
import { previewModelAuthoring, type AuthoringRow, type ModelAuthoringPreview } from './model-authoring-preview';
import { undoBatch, type AppliedChange, type CommitOutcome, type ModelChangeReceipt } from './model-change-commit';
import { commitElementSize } from '@/lib/element-size-commit';
import { setElementProfile } from '@/store/slices/mutation-element-profile';
import { writeStairLifecycle, writeStairCreation } from './model-authoring-stair-lifecycle';
import { nativePlacementFromTarget } from './model-authoring-placement';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
import { completeEntityRemoval } from '@/store/slices/mutation-mesh-stash';
import { completeStairRailingGeometry } from '@/store/slices/mutation-stair-railing';
import { writeAuthoringReach } from './model-authoring-reach';
import { sizeInMetres } from './model-authoring-size-params';
import { profileInMetres } from './model-authoring-shape-params';
import { addClassificationInDraft } from '@/lib/authoring/associations';
import { classificationInput, classificationLabel } from './model-authoring-classification';
import { resolveEnglish } from '@/i18n/registry';

/** Rows that will be written: approved, ready, and every creation they use is written too. */
export function writableRows(preview: ModelAuthoringPreview, approved: ReadonlySet<number>): AuthoringRow[] {
  const chosen = new Set<number>();
  for (const row of preview.rows) {
    if (approved.has(row.index) && row.status === 'ready' && row.dependsOn.every((i) => chosen.has(i))) chosen.add(row.index);
  }
  return preview.rows.filter((row) => chosen.has(row.index));
}

interface Written { created: number[]; deleted: number[]; remesh: number[]; moved: boolean }

const fmt = (batch: ModelAuthoringBatch, values: readonly number[]) =>
  `(${values.map((v) => Number((batch.units === 'mm' ? v * 1000 : v).toFixed(batch.units === 'mm' ? 1 : 4))).join(', ')}) ${batch.units}`;

function createElement(s: ViewerState, modelId: string, storey: number, element: ReturnType<typeof authoredElementOf>): number {
  let out: { expressId: number } | { error: string };
  switch (element.kind) {
    case 'wall': out = s.addWall(modelId, storey, element.params); break;
    case 'slab': out = s.addSlab(modelId, storey, element.params); break;
    case 'roof': out = s.addRoof(modelId, storey, element.params); break;
    case 'plate': out = s.addPlate(modelId, storey, element.params); break;
    case 'column': out = s.addColumn(modelId, storey, element.params); break;
    case 'beam': out = s.addBeam(modelId, storey, element.params); break;
    case 'member': out = s.addMember(modelId, storey, element.params); break;
    case 'space': out = s.addSpace(modelId, storey, element.params); break;
  }
  if ('error' in out) throw new Error(out.error);
  return out.expressId;
}

/** Write one row; throws so the transaction rolls the model back. */
function writeRow(tx: AuthoringTransaction, batch: ModelAuthoringBatch, row: AuthoringRow, refs: Map<string, string | number>, ids: Map<string, number>, written: Written): AppliedChange[] {
  const modelId = row.modelId!;
  const { op, resolved, before } = row;
  const base = { index: row.index, op: op.op, modelId };
  const targetGid = 'target' in op && !('ref' in op.target) ? op.target.globalId : undefined;
  switch (op.op) {
    case 'classification.add': {
      const dataStore = tx.store.models.get(modelId)?.ifcDataStore;
      if (!dataStore) throw new Error('The native model source is unavailable');
      recordModellingEdit(tx.api, modelId, (_methods, draft) => {
        const outcome = addClassificationInDraft(dataStore, draft, resolved.target!, classificationInput(op, dataStore.schemaVersion));
        if (!outcome.ok) throw new Error(resolveEnglish(outcome.reasonKey));
      }, tx.batchId);
      return [{ ...base, globalId: op.target.globalId, field: 'Classification', before: null, after: classificationLabel(op) }];
    }
    case 'element.replace': return commitNativeReplacement(tx,batch,row,refs,ids,written);
