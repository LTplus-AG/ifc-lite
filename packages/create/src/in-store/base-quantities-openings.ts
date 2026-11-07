/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RelationshipType } from '@ifc-lite/data';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { asExpressIdRef, readAttributes } from './edit/placement-core.js';

/**
 * The openings the FILE voids a loaded host with that this session has not
 * removed, through the parsed relationship graph: one host's edges, never a
 * walk of the file. Null when the store has no graph to ask, so the caller
 * cannot tell an unvoided host from an unreadable one.
 */
export function fileOpeningsOf(dataStore: IfcDataStore, view: MutablePropertyView, editor: StoreEditor, hostId: number): number[] | null {
  const graph = dataStore.relationships;
  if (!graph) return null;
  const openings: number[] = [];
  for (const opening of graph.getRelated(hostId, RelationshipType.VoidsElement, 'forward')) {
    if (view.isDeleted(opening) || openings.includes(opening)) continue;
    // The relationship still has to say so: the session may have deleted or re-pointed it.
    const live = graph.getRelationshipsBetween(hostId, opening).some(({ relationshipId, type }) => {
      if (type !== RelationshipType.VoidsElement || view.isDeleted(relationshipId)) return false;
      const rel = readAttributes(dataStore, view, editor, relationshipId);
      return asExpressIdRef(rel?.[4]) === hostId && asExpressIdRef(rel?.[5]) === opening;
    });
    if (live) openings.push(opening);
  }
  return openings;
}
