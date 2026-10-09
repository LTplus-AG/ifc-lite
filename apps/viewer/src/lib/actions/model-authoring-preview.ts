/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Preflight for a reviewed authoring batch: resolve every element, storey,
 * type and material; check the edit gate and each expected class, name, type,
 * material, position and angle against the effective model; then let the
 * native builders decide in a dry run on a draft overlay. The preview is a
 * pure snapshot (it writes nothing); commit re-runs it and refuses if
 * anything moved since.
 */

import { resolveReviewedLayers, LayerRefusal } from './model-authoring-layers';
import { gridCreationGhost } from './model-authoring-grid-ghost';
import { nativeGridExpected, sameGridExpected } from './model-authoring-grid-native';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
import { readNativeReplacementExpected } from './model-authoring-replacement';
import { authoringSlabOpeningGhost } from './model-authoring-slab-opening-ghost';
import { verifySlabOpeningHost } from './model-authoring-slab-opening';
import { stairRailingGhost } from './model-authoring-stair-railing-ghost';
import { nativeStairEvidence, sameStairSnapshot } from './model-authoring-stair-lifecycle';
import { stairPatchInMetres } from './model-authoring-stair-railing-fields';
import type { ViewerState } from '@/store';
import { mutationDenial } from '@/store/mutation-permission';
import { stairRailingRefusal } from '@/store/slices/mutation-stair-railing';
import { materialsOf, typeOf } from '@/lib/commands/modeling/authored-kinds';
import { copiedProductsInStore, createCopyContext, productStoreyOrigin, liveEntityConforms } from '@ifc-lite/create';
import { batchDigest } from './model-change-preview';
import { isNewElement, toMetres, type AuthoringOp, type ElementTarget, type ExistingElement, type ModelAuthoringBatch } from './model-authoring';
import type { ElementId } from './model-authoring-native';
import { validateAuthoringDraft } from './model-authoring-preview-draft';
import {
  authoringReader, className, conforms, deletionRefusal, materialNameOf, nameOf, typeNameOf, type AuthoringReader,
} from './model-authoring-read';
import { captureAuthoringSources } from './model-authoring-sources';
import { resolveGlobalId } from './resolve-global-id';
import { readElementProfileFromTarget } from '@/store/slices/mutation-element-profile';
import { readAuthoringSizeFromTarget, sameNativeDimensions } from './model-authoring-size';
import { verifyReachExpected, verifyReachStoreyFrame, reachBefore } from './model-authoring-reach';
import { sizeInMetres } from './model-authoring-size-params';
import { profileInMetres } from './model-authoring-shape-params';
import { classificationInput } from './model-authoring-classification';
import { authoringHostedEditGhost } from './model-authoring-hosted-edit-ghost';
import { hostedFillRefusal } from '@/store/slices/mutation-hosted-fill';
import { readExpectedHostedEdit, sameHostedEdit } from './model-authoring-hosted-edit';
import { readSplitSnapshot, sameSplitSnapshot } from './model-authoring-split-state';
import { uniqueSplitGuid } from './model-authoring-split';
import { authoringSplitMarker } from './model-authoring-split-ghost';
import { authoringSizeGhost } from './model-authoring-size-ghost';
import { reviewAlignment } from './model-authoring-align';
import { reviewElementTransform } from './model-authoring-transform-review';
import { AuthoringRefusal as Refusal } from './model-authoring-preview-refusal';

import type { AuthoringRowStatus, AuthoringRow, ModelAuthoringPreview } from './model-authoring-preview-types';
export type { AuthoringRowStatus, AuthoringBefore, AuthoringRow, ModelAuthoringPreview } from './model-authoring-preview-types';

interface Context {
  state: ViewerState;
  batch: ModelAuthoringBatch;
  readers: Map<string, AuthoringReader | null>;
  /** ref → index of the row that creates it. */
  creators: Map<string, number>;
  rows: AuthoringRow[];
}

function reader(ctx: Context, modelId: string): AuthoringReader {
  if (!ctx.readers.has(modelId)) ctx.readers.set(modelId, authoringReader(ctx.state, modelId));
  const found = ctx.readers.get(modelId);
  if (!found) throw new Refusal('missing-target', 'The model is not loaded');
  return found;
}

function locate(ctx: Context, target: { globalId: string; modelId?: string }): { modelId: string; expressId: number } {
  const hit = resolveGlobalId(ctx.state, target);
  if (hit === 'missing') throw new Refusal('missing-target', `${target.globalId} is not in a loaded model`);
  if (hit === 'ambiguous') throw new Refusal('ambiguous-target', `${target.globalId} is in several models; name the model`);
  return hit;
}

function existing(ctx: Context, target: ExistingElement, row: AuthoringRow): number {
  const { modelId, expressId } = locate(ctx, target);
  join(row, modelId);
  const r = reader(ctx, modelId);
  if ((row.op.op.startsWith('stair.') || row.op.op.startsWith('railing.')) && !uniqueSplitGuid(r.dataStore, r.editor, target.globalId)) throw new Refusal('ambiguous-target', 'The native stair or railing target GlobalId is not unique in its owning model');
  if ((row.op.op === 'material.layers' || row.op.op === 'element.replace' || row.op.op === 'element.align' || (row.op.op === 'element.rotate' && !!row.op.pivot) || row.op.op === 'element.split' || row.op.op === 'element.trimExtend' || row.op.op === 'type.detach' || row.op.op === 'classification.add') && !uniqueSplitGuid(r.dataStore, r.editor, target.globalId)) throw new Refusal('ambiguous-target', 'The native target GlobalId is not unique in its owning model');
