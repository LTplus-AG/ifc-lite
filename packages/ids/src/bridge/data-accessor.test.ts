/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';

import { createDataAccessor } from './data-accessor.js';

/**
 * Minimal store stub modelling a window that fills an opening which voids
 * a wall:
 *
 *   IfcWindow(10) --FillsElement--> IfcOpeningElement(20) --VoidsElement--> IfcWall(30)
 *
 * `getRelated(..., 'inverse')` returns the relating side given the related
 * side, matching how the real CSR graph is built (see
 * `parser/on-demand-extractors.ts`). `entityIndex.byId` is left empty so
 * the on-demand attribute extractor short-circuits without touching a
 * source buffer.
 */
function makeStore(): IfcDataStore {
  const types = new Map<number, string>([
    [10, 'IfcWindow'],
    [20, 'IfcOpeningElement'],
    [30, 'IfcWall'],
  ]);
  // inverse adjacency: relatedId -> relType -> relatingIds
  const inverse = new Map<number, Map<RelationshipType, number[]>>([
    [10, new Map([[RelationshipType.FillsElement, [20]]])],
    [20, new Map([[RelationshipType.VoidsElement, [30]]])],
  ]);

  return {
    schemaVersion: 'IFC4',
    source: new Uint8Array(),
    entities: {
      getTypeName: (id: number) => types.get(id),
      getObjectType: () => undefined,
      getName: () => undefined,
      getGlobalId: () => undefined,
      getDescription: () => undefined,
    },
    entityIndex: { byId: new Map(), byType: new Map() },
    relationships: {
      getRelated: (
        id: number,
        relType: RelationshipType,
        direction: 'forward' | 'inverse'
      ) => (direction === 'inverse' ? inverse.get(id)?.get(relType) ?? [] : []),
    },
  } as unknown as IfcDataStore;
}

describe('createDataAccessor — merged voids/fills partOf relation (issue #1205)', () => {
  it('walks both Fills and Voids edges so a window reaches its host wall', () => {
    const accessor = createDataAccessor(makeStore());
    const ancestors = accessor.getAncestors!(
      10,
      'IfcRelVoidsElement IfcRelFillsElement'
    );
    const types = ancestors.map((a) => a.entityType);
    // The window fills an opening (FillsElement) which voids a wall
    // (VoidsElement); both are reachable through the chained relation.
    expect(types).toContain('IfcOpeningElement');
    expect(types).toContain('IfcWall');
  });

  it('resolves an opening directly to its voided wall', () => {
    const accessor = createDataAccessor(makeStore());
    const ancestors = accessor.getAncestors!(
      20,
      'IfcRelVoidsElement IfcRelFillsElement'
    );
    expect(ancestors.map((a) => a.entityType)).toEqual(['IfcWall']);
  });

  it('does not reach the host wall via the single FillsElement relation alone', () => {
    const accessor = createDataAccessor(makeStore());
    // A plain fills relation only hops window -> opening, never to the wall.
    const ancestors = accessor.getAncestors!(10, 'IfcRelFillsElement');
    expect(ancestors.map((a) => a.entityType)).toEqual(['IfcOpeningElement']);
  });
});
