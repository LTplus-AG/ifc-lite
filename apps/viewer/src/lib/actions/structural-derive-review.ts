/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review and apply a derived structural analysis model (#9668). The plan comes
 * from `@ifc-lite/create`'s derivation; it is dry-run applied on a detached
 * lease so the review can show what will be written and refuse before Apply,
 * then applied once as one recorded edit, so one Undo removes it.
 *
 * The derivation loads with the structural write path, in its own chunk:
 * callers await `loadStructuralWrites()` first.
 */

import type { StoreApi } from 'zustand';
import { StoreEditor } from '@ifc-lite/mutations';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import type { StructuralDerivationOptions, StructuralDerivationPlan } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import { loadedStructuralWrites } from '@/sdk/adapters/store-adapter-structural';
import { readOnlyModelEditLease } from './model-authoring-read-target';
import { batchDigest } from './model-change-preview';
import type { ModelChangeReceipt } from './model-change-commit';

export interface StructuralDerivationReview {
  modelId: string;
  plan: StructuralDerivationPlan;
  /** Records the dry run wrote: what Apply will create. */
  created: number;
  digest: string;
  validate(): void;
  commit(): { batchId: string; analysisModelId: number };
}

/** The model a derivation runs on: the active one, else the first loaded, as the modelling workspace picks. */
export function derivationModelId(state: Pick<ViewerState, 'models' | 'activeModelId'>): string | null {
  const candidates = [state.activeModelId ?? undefined, state.models.keys().next().value];
  return candidates.find((id): id is string => id !== undefined && state.models.get(id)?.ifcDataStore != null) ?? null;
}

export function prepareStructuralDerivationReview(
  store: StoreApi<ViewerState>,
  modelId: string,
  options: StructuralDerivationOptions = {},
): StructuralDerivationReview {
  const state = store.getState();
  const denial = mutationDenial(state, modelId);
  if (denial) throw new Error(denial);
  const lease = readOnlyModelEditLease(state, modelId);
  if (!lease) throw new Error('The loaded model is unavailable');
  const derive = loadedStructuralWrites('Structural derivation');
  const { dataStore } = lease.target;
  const plan = derive.planStructuralDerivation(derive.readStructuralDerivationFacts(dataStore, lease.target.editor), options);
  // Nothing to write, or a derived model already there: no dry run; the review shows why and offers no Apply.
  const blocked = plan.curveMembers.length + plan.surfaceMembers.length === 0 || plan.derivedModelId !== null;
  const created = blocked ? 0 : lease.target.view.prepareAtomic((view) => {
    const draft = new StoreEditor(dataStore, view);
    derive.applyStructuralDerivation(draft, dataStore, plan);
    return draft.getNewEntities().length;
  }).result;
  const model = state.models.get(modelId), view = state.mutationViews.get(modelId), revision = view?.getMutationRevision();
  const validate = () => {
    const current = store.getState();
    if (current.models.get(modelId) !== model || current.mutationViews.get(modelId) !== view || view?.getMutationRevision() !== revision) {
      throw new Error('The model changed after this derivation was reviewed; review it again');
    }
    lease.validate();
    const refusal = mutationDenial(current, modelId);
    if (refusal) throw new Error(refusal);
  };
  let used = false;
  return {
    modelId, plan, created, digest: batchDigest({ modelId, plan }), validate,
    commit() {
      if (used) throw new Error('This derivation has already been applied');
      if (blocked) throw new Error('Structural derivation: this plan has nothing it may write');
      validate();
      const batchId = crypto.randomUUID();
      // Apply re-checks the live store (deleted elements, an existing derived model) before its first write.
      const { analysisModelId } = recordModellingEdit(store, modelId, (_methods, draft) => derive.applyStructuralDerivation(draft, dataStore, plan), batchId);
      used = true;
      return { batchId, analysisModelId };
    },
  };
}

/** Apply the reviewed derivation and describe it as a receipt: one row, the derived analysis model. */
export function commitStructuralDerivation(store: StoreApi<ViewerState>, review: StructuralDerivationReview, origin: string): ModelChangeReceipt {
  const { batchId, analysisModelId } = review.commit();
  const { modelId, plan } = review;
  const record = effectiveMetadataRecord(store.getState().models.get(modelId)!.ifcDataStore!, analysisModelId, store.getState().mutationViews.get(modelId));
  const globalId = record?.attributes[0];
  return {
    version: 1, kind: 'structural.graph', id: crypto.randomUUID(), title: 'Derived analysis model', digest: review.digest,
    createdAt: new Date().toISOString(), origin, status: 'applied', batches: [{ modelId, batchId }],
    applied: [{ index: 0, op: 'structural.analysis.create', expressId: analysisModelId, modelId, globalId: typeof globalId === 'string' ? globalId : '',
      field: 'structural.derive', before: null, after: JSON.stringify(plan.report.counts) }],
    skipped: [],
  };
}
