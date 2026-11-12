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
import type { StructuralDerivationPlan } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import { loadedStructuralWrites } from '@/sdk/adapters/store-adapter-structural';
import { resolveModelId } from '@/lib/commands/modeling/workspace-target';
import { readOnlyModelEditLease } from './model-authoring-read-target';
import { batchDigest } from './model-change-preview';
import type { ModelChangeReceipt } from './model-change-commit';

export interface StructuralDerivationReview {
  modelId: string;
  plan: StructuralDerivationPlan;
  /** Records the dry run wrote: what Apply will create. */
  created: number;
  /** Rows the receipt will list: the analysis model, each member and each node. */
  derived: number;
  /** The cheap staleness check, run on store updates; Apply also checks the held lease. */
  validate(): void;
  commit(): { batchId: string; analysisModelId: number; created: ReadonlyArray<{ expressId: number; type: string }> };
}

/** The model a derivation runs on: the active one, else the first loaded. */
export function derivationModelId(state: Pick<ViewerState, 'models' | 'activeModelId'>): string | null {
  return resolveModelId(state, undefined);
}

export function prepareStructuralDerivationReview(store: StoreApi<ViewerState>, modelId: string): StructuralDerivationReview {
  const state = store.getState();
  const denial = mutationDenial(state, modelId);
  if (denial) throw new Error(denial);
  const lease = readOnlyModelEditLease(state, modelId);
  if (!lease) throw new Error('The loaded model is unavailable');
  // Not 'Structural derivation:': that prefix is the create code's, which the lazy-writes gate looks for.
  const derive = loadedStructuralWrites('Derive structural model');
  const { dataStore } = lease.target;
  const plan = derive.planStructuralDerivation(derive.readStructuralDerivationFacts(dataStore, lease.target.editor));
  // Nothing to write, or an analysis model already there (apply would refuse): no dry run; the review shows why.
  const blocked = plan.curveMembers.length + plan.surfaceMembers.length === 0 || plan.refusal !== null;
  // A dry run in its own snapshot, so the held review keeps only counts: the records and the receipt's rows.
  const { created, derived } = blocked ? { created: 0, derived: 0 } : lease.target.view.prepareAtomic((view) => {
    const draft = new StoreEditor(dataStore, view);
    derive.applyStructuralDerivation(draft, dataStore, plan);
    const written = draft.getNewEntities();
    return { created: written.length, derived: written.filter(({ type }) => RECEIPT_OPS[type.toUpperCase()]).length };
  }).result;
  const view = state.mutationViews.get(modelId), revision = view?.getMutationRevision();
  const validate = () => {
    const current = store.getState(), live = current.mutationViews.get(modelId);
    // The parsed store and its edits count, not the model's name or visibility. A view registered after Prepare
    // with no overlay entries (an export or an editor opening the model) holds the same content.
    const sameEdits = view ? live === view && view.getMutationRevision() === revision : !live?.hasPendingChanges();
    if (current.models.get(modelId)?.ifcDataStore !== dataStore || !sameEdits) {
      throw new Error('The model changed after this derivation was reviewed; review it again');
    }
    const refusal = mutationDenial(current, modelId);
    if (refusal) throw new Error(refusal);
  };
  let used = false;
  return {
    modelId, plan, created, derived, validate,
    commit() {
      if (used) throw new Error('This derivation has already been applied');
      if (blocked) throw new Error('This derivation has nothing it may write');
      validate();
      // The deep overlay comparison, only at Apply: store updates run the cheap check above.
      lease.validate();
      const batchId = crypto.randomUUID();
      // The plan the user reviewed, not a new one. Apply re-checks the live store (deleted elements, an existing
      // analysis model) and the whole plan before its first write, and writes in its own transaction inside this edit.
      const { analysisModelId, created } = recordModellingEdit(store, modelId, (_methods, draft) => {
        const before = draft.getNewEntities().length;
        const applied = derive.applyStructuralDerivation(draft, dataStore, plan);
        return { ...applied, created: draft.getNewEntities().slice(before).map(({ expressId, type }) => ({ expressId, type })) };
      }, batchId);
      used = true;
      return { batchId, analysisModelId, created };
    },
  };
}

/** Rows the receipt lists: the analysis model and every member and connection, each with its written record. */
const RECEIPT_OPS: Record<string, 'structural.analysis.create' | 'structural.member.create' | 'structural.connection.create'> = {
  IFCSTRUCTURALANALYSISMODEL: 'structural.analysis.create',
  IFCSTRUCTURALCURVEMEMBER: 'structural.member.create',
  IFCSTRUCTURALSURFACEMEMBER: 'structural.member.create',
  IFCSTRUCTURALPOINTCONNECTION: 'structural.connection.create',
};

/** Apply the reviewed derivation and describe it as a receipt, one row per derived item. */
export function commitStructuralDerivation(store: StoreApi<ViewerState>, review: StructuralDerivationReview, origin: string): ModelChangeReceipt {
  const { batchId, created } = review.commit();
  const { modelId, plan } = review;
  const state = store.getState(), dataStore = state.models.get(modelId)!.ifcDataStore!, view = state.mutationViews.get(modelId);
  const applied = created.flatMap(({ expressId, type }) => {
    const op = RECEIPT_OPS[type.toUpperCase()];
    const record = op ? effectiveMetadataRecord(dataStore, expressId, view) : null;
    if (!op || !record) return [];
    const globalId = record.attributes[0];
    return [{ op, expressId, modelId, globalId: typeof globalId === 'string' ? globalId : '', field: op,
      before: null, after: JSON.stringify({ expressId, ...record }) }];
  }).map((row, index) => ({ index, ...row }));
  return {
    version: 1, kind: 'structural.graph', id: crypto.randomUUID(), title: 'Derived analysis model', digest: batchDigest({ modelId, plan }),
    createdAt: new Date().toISOString(), origin, status: 'applied', batches: [{ modelId, batchId }], applied, skipped: [],
  };
}
