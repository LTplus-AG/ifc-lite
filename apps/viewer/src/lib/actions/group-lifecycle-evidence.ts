/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readGroupCreateEvidenceInStore, readGroupEvidenceInStore, type GroupCreateEvidence, type GroupNativeEvidence } from '@ifc-lite/create';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';

export type NativeGroupEvidence = { status: 'available'; snapshot: GroupNativeEvidence | GroupCreateEvidence }
  | { status: 'unavailable-source' | 'unavailable-complete-graph' | 'unavailable-selection-budget' | 'unavailable-transport-budget'; snapshot: null };
/** Shared across models; includes JSON escaping and chunk/envelope overhead. */
export function groupTransportBudget() { return { remaining: 12_000 }; }
/**
 * A selection that touches no exact generic IfcGroup publishes bounded
 * create-only facts from type buckets; only a selection in group context pays
 * for the whole-model graph (#7346). Review reads the complete graph either way.
 */
export function nativeGroupEvidence(target: ModelEditTarget | null, selected: readonly number[], budget = groupTransportBudget()): NativeGroupEvidence {
  if (!target?.dataStore.source.byteLength) return { status: 'unavailable-source', snapshot: null };
  try {
    const context = { store: target.dataStore, mutationView: target.view, ownerHistoryId: null };
    const snapshot = readGroupCreateEvidenceInStore(context, selected) ?? readGroupEvidenceInStore(context, selected);
    const cost = JSON.stringify(JSON.stringify(snapshot)).length + 512;
    if (cost > budget.remaining) return { status: 'unavailable-transport-budget', snapshot: null };
    budget.remaining -= cost;
    return { status: 'available', snapshot };
  } catch (error) {
    console.warn('[Assistant] Complete native Group evidence unavailable', error);
    return { status: 'unavailable-complete-graph', snapshot: null };
  }
}
/** Chunk only complete serialized facts to the public evidence field's string bound. */
export function nativeGroupTransportEvidence(target: ModelEditTarget | null, selected: readonly number[], budget = groupTransportBudget()) {
  const evidence = nativeGroupEvidence(target, selected, budget);
  const json = evidence.snapshot ? JSON.stringify(evidence.snapshot) : null;
  return { status: evidence.status, expectedJsonParts: json ? Array.from({ length: Math.ceil(json.length / 1000) }, (_, index) => json.slice(index * 1000, (index + 1) * 1000)) : null };
}
