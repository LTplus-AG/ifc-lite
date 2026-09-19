/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  EntityTableBuilder,
  RelationshipGraphBuilder,
  RelationshipType,
  StringTable,
} from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { extractExactRelatedIds, extractExactRelationshipEdges } from './exact-relationship-edges.js';

describe('exact relationship edge display data (#4205)', () => {
  it('canonicalizes an endpoint available only through its raw STEP ref', () => {
    const graph = new RelationshipGraphBuilder();
    graph.addEdge(10, 20, RelationshipType.AssociatesMaterial, 30);
    const entities = new EntityTableBuilder(0, new StringTable()).build();
    const store = {
      entities,
      entityIndex: {
        byId: new Map([[10, {
          expressId: 10,
          type: 'IFCMATERIAL',
          byteOffset: 0,
          byteLength: 0,
          lineNumber: 1,
        }]]),
        byType: new Map(),
      },
      relationships: graph.build(),
    } as unknown as IfcDataStore;

    expect(extractExactRelationshipEdges(store, 20)).toEqual([{
      relationshipId: 30,
      relationshipType: 'IfcRelAssociatesMaterial',
      direction: 'inverse',
      entity: { id: 10, type: 'IfcMaterial' },
    }]);
  });

  it('keeps distinct legacy-server rows while suppressing compatibility aliases', () => {
    const graph = new RelationshipGraphBuilder();
    graph.addEdge(10, 20, RelationshipType.Aggregates, 0);
    // A legacy-server IfcRelNests row occupies both buckets with id 0.
    graph.addEdge(10, 20, RelationshipType.Aggregates, 0);
    graph.addEdge(10, 20, RelationshipType.Nests, 0);
    graph.addEdge(10, 20, RelationshipType.ConnectsElements, 0);
    const entities = new EntityTableBuilder(0, new StringTable()).build();
    const store = {
      entities,
      entityIndex: { byId: new Map(), byType: new Map() },
      relationships: graph.build(),
    } as unknown as IfcDataStore;

    expect(extractExactRelationshipEdges(store, 10).map((edge) => edge.relationshipType)).toEqual([
      'IfcRelAggregates',
      'IfcRelNests',
      'IfcRelConnectsElements',
    ]);
  });

  it('separates exact queries from broad compatibility buckets', () => {
    const graph = new RelationshipGraphBuilder();
    graph.addEdge(10, 20, RelationshipType.Aggregates, 101);
    graph.addEdge(10, 30, RelationshipType.Aggregates, 102);
    graph.addEdge(10, 30, RelationshipType.Nests, 102);
    const strings = new StringTable();
    const builder = new EntityTableBuilder(2, strings);
    builder.add(101, 'IFCRELAGGREGATES', '', '', '', '', false, false);
    builder.add(102, 'IFCRELNESTS', '', '', '', '', false, false);
    const store = {
      entities: builder.build(),
      entityIndex: { byId: new Map(), byType: new Map() },
      relationships: graph.build(),
    } as unknown as IfcDataStore;

    expect(extractExactRelatedIds(store, 10, 'IfcRelAggregates', 'forward')).toEqual([20]);
    expect(extractExactRelatedIds(store, 10, 'IfcRelNests', 'forward')).toEqual([30]);
    expect(extractExactRelatedIds(store, 10, 'IfcRelNests', 'forward', (id) => id === 102)).toEqual([]);
  });

  it('infers exact aliases when a server payload omits relationship entity rows', () => {
    const graph = new RelationshipGraphBuilder();
    graph.addEdge(10, 20, RelationshipType.Aggregates, 101);
    graph.addEdge(10, 30, RelationshipType.Aggregates, 102);
    graph.addEdge(10, 30, RelationshipType.Nests, 102);
    graph.addEdge(10, 40, RelationshipType.AssignsToGroup, 103);
    graph.addEdge(10, 40, RelationshipType.AssignsToGroupByFactor, 103);
    const store = {
      entities: new EntityTableBuilder(0, new StringTable()).build(),
      entityIndex: { byId: new Map(), byType: new Map() },
      relationships: graph.build(),
    } as unknown as IfcDataStore;

    expect(extractExactRelationshipEdges(store, 10).map((edge) => edge.relationshipType)).toEqual([
      'IfcRelAggregates',
      'IfcRelNests',
      'IfcRelAssignsToGroupByFactor',
    ]);
    expect(extractExactRelatedIds(store, 10, 'IfcRelAggregates', 'forward')).toEqual([20]);
    expect(extractExactRelatedIds(store, 10, 'IfcRelNests', 'forward')).toEqual([30]);
    expect(extractExactRelatedIds(store, 10, 'IfcRelAssignsToGroupByFactor', 'forward')).toEqual([40]);
  });
});
