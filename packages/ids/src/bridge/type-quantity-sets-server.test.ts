/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type-held quantity sets on server-parsed stores (#ISSUE). The source-backed
 * `extractTypeQuantitiesOnDemand` returns null without a `source` buffer, so
 * the bridge reads the prebuilt quantity table under the element's type id,
 * where the server materialises the type's `HasPropertySets` quantity sets
 * (TYPEHASPROPERTYSETS), as it already did for property sets (#1787).
 */

import { describe, it, expect } from 'vitest';
import { QuantityType, RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { checkPropertyFacet } from '../facets/property-facet.js';
import type { IDSPropertyFacet, IDSSimpleValue } from '../types.js';
import { createDataAccessor } from './data-accessor.js';

const WALL = 10;
const OVERRIDING_WALL = 11;
const TYPE = 20;

const qto = (quantities: Array<[string, number]>) => [
  {
    name: 'Qto_WallBaseQuantities',
    globalId: '',
    quantities: quantities.map(([name, value]) => ({ name, type: QuantityType.Length, value })),
  },
];

// Server-shaped store: empty `source`; both walls --DefinesByType--> type #20,
// whose Qto_WallBaseQuantities lives under the TYPE id in the quantity table.
// Wall #11 carries its own Length.
function serverStore(): IfcDataStore {
  const quantities = new Map([
    [TYPE, qto([['Length', 5], ['Height', 3]])],
    [OVERRIDING_WALL, qto([['Length', 7]])],
  ]);
  return {
    schemaVersion: 'IFC4',
    source: new Uint8Array(), // server path
    entities: {
      getTypeName: (id: number) => (id === TYPE ? 'IfcWallType' : 'IfcWall'),
      getByType: () => [WALL, OVERRIDING_WALL],
      getName: () => undefined,
      getGlobalId: () => undefined,
      getDescription: () => undefined,
      getObjectType: () => undefined,
    },
    entityIndex: { byId: new Map(), byType: new Map() },
    relationships: {
      getRelated: (id: number, relType: RelationshipType, dir: 'forward' | 'inverse') =>
        dir === 'inverse' && id !== TYPE && relType === RelationshipType.DefinesByType ? [TYPE] : [],
    },
    properties: { getForEntity: () => [] },
    quantities: { getForEntity: (id: number) => quantities.get(id) ?? [] },
  } as unknown as IfcDataStore;
}

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });
const facet = (name: string, value?: string): IDSPropertyFacet => ({
  type: 'property',
  propertySet: sv('Qto_WallBaseQuantities'),
  baseName: sv(name),
  dataType: sv('IFCLENGTHMEASURE'),
  ...(value === undefined ? {} : { value: sv(value) }),
});

describe('IDS type-held quantity sets on server-parsed stores (#ISSUE)', () => {
  it('resolves a quantity only the type holds', () => {
    const accessor = createDataAccessor(serverStore());
    expect(checkPropertyFacet(facet('Length', '5'), WALL, accessor).passed).toBe(true);
    expect(checkPropertyFacet(facet('Height', '3'), WALL, accessor).passed).toBe(true);
  });

  it("keeps the occurrence's own value and tops its set up with the type's", () => {
    const accessor = createDataAccessor(serverStore());
    expect(checkPropertyFacet(facet('Length', '7'), OVERRIDING_WALL, accessor).passed).toBe(true);
    expect(checkPropertyFacet(facet('Length', '5'), OVERRIDING_WALL, accessor).passed).toBe(false);
    expect(checkPropertyFacet(facet('Height', '3'), OVERRIDING_WALL, accessor).passed).toBe(true);
  });

  it('does not invent a quantity the type lacks', () => {
    const accessor = createDataAccessor(serverStore());
    const result = checkPropertyFacet(facet('Width'), WALL, accessor);
    expect(result.passed).toBe(false);
    expect(result.failure?.type).toBe('PROPERTY_MISSING');
  });
});
