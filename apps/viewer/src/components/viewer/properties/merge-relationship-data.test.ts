/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { EntityRelationshipsData } from '@ifc-lite/sdk';
import { groupMembersForRef, mergeRelationshipData, relationshipsForSelection } from './merge-relationship-data.js';

const empty = (): EntityRelationshipsData => ({ voids: [], fills: [], groups: [], connections: [], relations: [] });

test('duplicate relationship data includes inherited and directly-authored edges', () => {
  const inherited = empty();
  inherited.relations = [{ relationshipId: 10, relationshipType: 'IfcRelAggregates', direction: 'inverse',
    entity: { id: 1, type: 'IfcBuilding' } }];
  const direct = empty();
  direct.relations = [{ relationshipId: 11, relationshipType: 'IfcRelAssociatesDocument', direction: 'forward',
    entity: { id: 2, type: 'IfcDocumentReference' } }];

  assert.deepEqual(mergeRelationshipData(inherited, direct).relations?.map(edge => edge.relationshipId), [10, 11]);
});

test('duplicate relationship data deduplicates the same effective edge', () => {
  const edge = { relationshipId: 10, relationshipType: 'IfcRelAggregates', direction: 'inverse' as const,
    entity: { id: 1, type: 'IfcBuilding' } };
  const inherited = { ...empty(), relations: [edge] };
  const direct = { ...empty(), relations: [edge] };
  assert.equal(mergeRelationshipData(inherited, direct).relations?.length, 1);
});

test('duplicate selection queries both the inherited source and selected id', () => {
  const queried: number[] = [];
  const result = relationshipsForSelection((ref) => {
    queried.push(ref.expressId);
    const data = empty();
    data.relations = [{ relationshipId: ref.expressId, relationshipType: 'IfcRelAggregates', direction: 'inverse',
      entity: { id: ref.expressId + 1, type: 'IfcBuilding' } }];
    return data;
  }, { modelId: 'm', expressId: 200 }, 100);

  assert.deepEqual(queried, [100, 200]);
  assert.deepEqual(result.relations?.map(edge => edge.relationshipId), [100, 200]);
});

test('group members follow effective assignment rows and ignore unrelated edges', () => {
  const relationships = empty();
  relationships.relations = [
    { relationshipId: 1, relationshipType: 'IfcRelAssignsToGroup', direction: 'forward',
      entity: { id: 20, name: 'Member', type: 'IfcSpace' } },
    { relationshipId: 2, relationshipType: 'IfcRelAssignsToGroup', direction: 'inverse',
      entity: { id: 30, type: 'IfcGroup' } },
    { relationshipId: 3, relationshipType: 'IfcRelAggregates', direction: 'forward',
      entity: { id: 40, type: 'IfcWall' } },
  ];

  assert.deepEqual(groupMembersForRef(() => relationships, { modelId: 'm', expressId: 10 }), [
    { id: 20, name: 'Member', type: 'IfcSpace' },
  ]);
});
