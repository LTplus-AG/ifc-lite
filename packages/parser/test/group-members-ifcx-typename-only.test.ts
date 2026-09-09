/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Package-level coverage for the IFCX-only branch of
 * `extractGroupMembersOnDemand` (#1622 IFCX follow-up):
 *
 *   // IFCX stores ingest with an EMPTY entityIndex.byId (no STEP byte spans
 *   // exist), so existence rides the EntityTable there: keep a member when
 *   // EITHER source knows the id. STEP stores keep byId as the primary gate
 *   // and resolve identically to before (#1622 IFCX follow-up).
 *   if (!ref && (!tableType || tableType === 'Unknown')) continue;
 *
 * Every other `packages/parser` test reaches this function via the STEP
 * ingestion path, where `entityIndex.byId` is always populated, so the
 * `!ref` half of the guard alone would satisfy every one of them — the
 * "EITHER source" half is otherwise verified only one package over, in
 * `packages/ifcx`'s `system-membership.test.ts`. This test builds a store
 * shaped like real IFCX ingest (`entityIndex.byId` missing the member id,
 * `store.entities.getTypeName` still resolving it) so the invariant is
 * pinned locally too.
 */

import { describe, it, expect } from 'vitest';
import { RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';
import { createSyntheticDataStore } from '../src/synthetic-data-store.js';
import { extractGroupMembersOnDemand } from '../src/on-demand-extractors.js';

describe('extractGroupMembersOnDemand — IFCX-shaped store (empty entityIndex.byId)', () => {
  it('keeps a member known only via store.entities.getTypeName', () => {
    const groupId = 1;
    const memberId = 2;

    const store = createSyntheticDataStore({
      schemaVersion: 'IFC4X3',
      fileSize: 0,
      entities: [
        { expressId: groupId, type: 'IfcSystem', name: 'HVAC System' },
        { expressId: memberId, type: 'IfcPipeSegment', name: 'Pipe' },
      ],
    });

    // Simulate real IFCX ingest: entityIndex.byId carries no STEP byte spans,
    // so it stays EMPTY for the member — existence must ride the EntityTable
    // (store.entities.getTypeName) instead.
    store.entityIndex.byId.delete(memberId);
    expect(store.entityIndex.byId.has(memberId)).toBe(false);
    // Sanity: the EntityTable still knows the type — this is what the
    // "EITHER source" branch is meant to fall back to.
    expect(store.entities.getTypeName(memberId)).toBe('IfcPipeSegment');

    // Wire the group -> member edge the way parseIfcx does (group -> member,
    // STEP direction).
    const relBuilder = new RelationshipGraphBuilder();
    relBuilder.addEdge(groupId, memberId, RelationshipType.AssignsToGroup, 100);
    store.relationships = relBuilder.build();

    const members = extractGroupMembersOnDemand(store, groupId);
    expect(members.map((m) => m.id)).toEqual([memberId]);
    expect(members[0]?.type).toBe('IfcPipeSegment');
  });
});
