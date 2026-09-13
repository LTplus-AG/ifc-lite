/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { QuantitySet } from '@ifc-lite/data';
import type { Mutation, QuantityMutation } from './types.js';

export interface QuantityMemberDeleteState {
  modelId: string;
  entityId: number;
  qsetName: string;
  quantName: string;
  baseQsets: QuantitySet[];
  entityQsets?: Map<string, QuantitySet>;
  setMutation(key: string, mutation: QuantityMutation): void;
  deleteMutation(key: string): void;
  deleteEntityQsets(): void;
  pushHistory(mutation: Mutation): void;
  mutationId(): string;
  key(): string;
}

/** Build and apply a member tombstone without deleting sibling quantities. */
export function deleteQuantityMember(state: QuantityMemberDeleteState): Mutation | null {
  const { entityId, qsetName, quantName, baseQsets, entityQsets } = state;
  const existsInBase = baseQsets.some(
    qset => qset.name === qsetName && qset.quantities.some(quantity => quantity.name === quantName),
  );
  const newQset = entityQsets?.get(qsetName);
  const existsInNew = newQset?.quantities.some(quantity => quantity.name === quantName) ?? false;
  if (!existsInBase && !existsInNew) return null;

  if (existsInBase) state.setMutation(state.key(), { operation: 'DELETE' });
  else state.deleteMutation(state.key());
  if (entityQsets && newQset) {
    newQset.quantities = newQset.quantities.filter(quantity => quantity.name !== quantName);
    if (newQset.quantities.length === 0) entityQsets.delete(qsetName);
    if (entityQsets.size === 0) state.deleteEntityQsets();
  }

  const mutation: Mutation = {
    id: state.mutationId(), type: 'DELETE_QUANTITY', timestamp: Date.now(),
    modelId: state.modelId, entityId, psetName: qsetName, propName: quantName,
  };
  state.pushHistory(mutation);
  return mutation;
}

export interface QuantitySetDeleteState {
  modelId: string;
  entityId: number;
  qsetName: string;
  baseQsets: QuantitySet[];
  entityQsets?: Map<string, QuantitySet>;
  deleteEntityQsets(): void;
  deleteMutation(name: string): void;
  maskSet(): void;
  setMutation(name: string): void;
  mutationId(): string;
  pushHistory(mutation: Mutation): void;
}

/** Delete a complete quantity set from both base and in-session overlays. */
export function deleteQuantitySetOverlay(state: QuantitySetDeleteState): Mutation {
  const { entityId, qsetName, entityQsets } = state;
  const inSession = entityQsets?.get(qsetName);
  if (entityQsets && inSession) {
    entityQsets.delete(qsetName);
    if (entityQsets.size === 0) state.deleteEntityQsets();
    for (const quantity of inSession.quantities) state.deleteMutation(quantity.name);
  }
  for (const qset of state.baseQsets) {
    if (qset.name !== qsetName) continue;
    state.maskSet();
    for (const quantity of qset.quantities) state.setMutation(quantity.name);
  }
  const mutation: Mutation = {
    id: state.mutationId(), type: 'DELETE_QUANTITY_SET', timestamp: Date.now(),
    modelId: state.modelId, entityId, psetName: qsetName,
  };
  state.pushHistory(mutation);
  return mutation;
}
