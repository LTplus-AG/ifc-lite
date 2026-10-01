/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import type { StoreApi } from '@/sdk/adapters/types';
import { resolveResource } from './resolver';
import type { LiveEntity, SemanticResource } from './types';

export function liveEntities(store: StoreApi = useViewerStore): LiveEntity[] {
  // Canonical adapter reads effective GlobalId edits, created entities and tombstones.
  return createQueryAdapter(store).entities({ types: ['IfcRoot'] }).map(entity => ({
    ...entity.ref, GlobalId: entity.globalId,
  })).filter(entity => entity.GlobalId.length > 0);
}
export function selectResources(resources: SemanticResource[], revisions: ReadonlyMap<string, string>,
  modelScope?: string, store: StoreApi = useViewerStore): number {
  // Re-read at the action boundary, never select an address cached before a model swap.
  const entities = liveEntities(store);
  const refs = resources.flatMap(resource => {
    const resolution = resolveResource(resource, entities, revisions, modelScope);
    return resolution.status === 'resolved' ? [resolution.ref] : [];
  });
  createSelectionAdapter(store).set(refs);
  return createSelectionAdapter(store).get().length;
}
