/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mutation } from '@ifc-lite/mutations';

export interface ChangeOperation {
  id: string;
  timestamp: number;
  mutations: readonly Mutation[];
  modelIds: readonly string[];
  entities: readonly { modelId: string; entityId: number }[];
  /** The existing undo command can replay the whole operation immediately. */
  isTop: boolean;
}

/** The active history, with federated Bulk batches represented once (#5902). */
export function changeOperations(
  undoStacks: ReadonlyMap<string, readonly Mutation[]>,
  batchTags: ReadonlyMap<string, string>,
  inverseTargets: ReadonlyMap<string, Mutation> = new Map(),
): ChangeOperation[] {
  const active = new Set<string>();
  for (const stack of undoStacks.values()) for (const mutation of stack) active.add(mutation.id);
  const hidden = new Set<string>();
  for (const [inverseId, target] of inverseTargets) {
    if (!active.has(inverseId)) continue;
    hidden.add(inverseId);
    hidden.add(target.id);
  }
  const grouped = new Map<string, Mutation[]>();
  for (const stack of undoStacks.values()) for (const mutation of stack) {
    if (hidden.has(mutation.id)) continue;
    const tag = batchTags.get(mutation.id);
    const id = tag ? `batch:${tag}` : `mutation:${mutation.id}`;
    const group = grouped.get(id) ?? [];
    group.push(mutation);
    grouped.set(id, group);
  }
  const positions = new Map<string, Map<string, number>>();
  for (const [modelId, stack] of undoStacks) {
    stack.forEach((mutation, index) => {
      const id = batchTags.has(mutation.id) ? `batch:${batchTags.get(mutation.id)}` : `mutation:${mutation.id}`;
      const byModel = positions.get(id) ?? new Map<string, number>();
      byModel.set(modelId, index);
      positions.set(id, byModel);
    });
  }
  return [...grouped].map(([id, mutations]) => {
    const ids = new Set(mutations.map(mutation => mutation.id));
    const counts = new Map<string, number>();
    const entitiesByKey = new Map<string, { modelId: string; entityId: number }>();
    let timestamp = 0;
    for (const mutation of mutations) {
      counts.set(mutation.modelId, (counts.get(mutation.modelId) ?? 0) + 1);
      // Georeference commands use entityId 0: there is no IFC product to
      // select or frame, so the drawer gives them a model-level label instead.
      if (mutation.entityId > 0) entitiesByKey.set(`${mutation.modelId}:${mutation.entityId}`, { modelId: mutation.modelId, entityId: mutation.entityId });
      timestamp = Math.max(timestamp, mutation.timestamp);
    }
    const modelIds = [...counts.keys()];
    const isTop = modelIds.every(modelId => {
      const stack = undoStacks.get(modelId) ?? [];
      const ownCount = counts.get(modelId)!;
      return stack.slice(-ownCount).every(mutation => ids.has(mutation.id));
    });
    return { id, timestamp, mutations, modelIds, entities: [...entitiesByKey.values()], isTop };
  }).sort((a, b) => {
    // Date.now() has millisecond resolution: a property edit and a Bulk
    // batch can share it. Their shared model stack still records true order.
    for (const modelId of a.modelIds) {
      const left = positions.get(a.id)?.get(modelId);
      const right = positions.get(b.id)?.get(modelId);
      if (left !== undefined && right !== undefined && left !== right) return right - left;
    }
    return b.timestamp - a.timestamp || b.id.localeCompare(a.id);
  });
}
