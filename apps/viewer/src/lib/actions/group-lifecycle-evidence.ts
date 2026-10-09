/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readGroupEvidenceInStore, type GroupNativeEvidence } from '@ifc-lite/create';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';

export type NativeGroupEvidence = { status: 'available'; snapshot: GroupNativeEvidence }
  | { status: 'unavailable-source' | 'unavailable-complete-graph' | 'unavailable-selection-budget'; snapshot: null };
export function nativeGroupEvidence(target: ModelEditTarget | null, selected: readonly number[]): NativeGroupEvidence {
  if (!target?.dataStore.source.byteLength) return { status: 'unavailable-source', snapshot: null };
  try {
    return { status: 'available', snapshot: readGroupEvidenceInStore({ store: target.dataStore, mutationView: target.view, ownerHistoryId: null }, selected) };
  } catch (error) {
    console.warn('[Assistant] Complete native Group evidence unavailable', error);
    return { status: 'unavailable-complete-graph', snapshot: null };
  }
}
/** Chunk only complete serialized facts to the public evidence field's string bound. */
export function nativeGroupTransportEvidence(target: ModelEditTarget | null, selected: readonly number[]) {
  const evidence = nativeGroupEvidence(target, selected);
  const json = evidence.snapshot ? JSON.stringify(evidence.snapshot) : null;
  return { status: evidence.status, expectedJsonParts: json ? Array.from({ length: Math.ceil(json.length / 1000) }, (_, index) => json.slice(index * 1000, (index + 1) * 1000)) : null };
}
