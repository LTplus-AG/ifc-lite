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
import { extractExactRelationshipEdges } from './exact-relationship-edges.js';

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
});
