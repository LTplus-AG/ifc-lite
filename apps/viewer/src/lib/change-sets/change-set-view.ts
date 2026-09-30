/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read-only views over the mutation slice's change sets (#6232 D4): the list
 * the Change sets panel shows, and one set's mutations grouped by element.
 */

import type { ChangeSet, Mutation } from '@ifc-lite/mutations';

export interface ChangeSetSummary {
  id: string;
  name: string;
  createdAt: number;
  mutationCount: number;
  active: boolean;
}

/** Every change set, oldest first, with its mutation count and whether new edits land in it. */
export function changeSetSummaries(
  changeSets: ReadonlyMap<string, ChangeSet>,
  activeId: string | null,
): ChangeSetSummary[] {
  return [...changeSets.values()]
    .map((set) => ({ id: set.id, name: set.name, createdAt: set.createdAt, mutationCount: set.mutations.length, active: set.id === activeId }))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export interface ChangeSetElementGroup {
  modelId: string;
  /** 0 for model-level edits (georeference, metadata) that have no element to select. */
  entityId: number;
  mutations: Mutation[];
}

/**
 * A change set's mutations, one group per element in the order the element
 * was first edited. Model-level edits (entityId 0) get one group per model.
 */
export function groupChangeSetByElement(changeSet: Pick<ChangeSet, 'mutations'>): ChangeSetElementGroup[] {
  const groups = new Map<string, ChangeSetElementGroup>();
  for (const mutation of changeSet.mutations) {
    const entityId = mutation.entityId > 0 ? mutation.entityId : 0;
    const key = `${mutation.modelId}:${entityId}`;
    let group = groups.get(key);
    if (!group) {
      group = { modelId: mutation.modelId, entityId, mutations: [] };
      groups.set(key, group);
    }
    group.mutations.push(mutation);
  }
  return [...groups.values()];
}

/** A download name for an exported set: its name reduced to file-safe characters. */
export function changeSetFileName(name: string): string {
  const stem = name.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `${stem || 'change-set'}.changeset.json`;
}
