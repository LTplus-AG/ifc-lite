/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type-property fallback for instance schedules (issue #1745).
 *
 * A property or QTO defined once on an element's IfcTypeProduct (via
 * IfcRelDefinesByType) must resolve on every instance row of a list, while a
 * value the instance defines locally still takes precedence over the type's.
 */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum } from '@ifc-lite/data';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import { executeList } from './engine.js';
import type { ListDataProvider, ListDefinition } from './types.js';

// Two walls of one type. Wall 1 overrides FireRating locally; Wall 2 inherits
// it. Manufacturer lives ONLY on the type, so both walls inherit it. The type
// also carries a QTO (Qto_WallBaseQuantities.Width) neither instance defines.
function createProvider(): ListDataProvider {
  const instancePsets = new Map<number, PropertySet[]>([
    [1, [{ name: 'Pset_WallCommon', globalId: 'inst-pset-1', properties: [{ name: 'FireRating', type: 0, value: 'REI 120' }] }]],
    [2, []],
  ]);
  const instanceQsets = new Map<number, QuantitySet[]>([
    [1, [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 5, type: 0 }] }]],
    [2, [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 3, type: 0 }] }]],
  ]);

  // Shared type-level data (as if from IfcWallType). FireRating REI 60 here is
  // the type default that Wall 1 overrides but Wall 2 inherits.
  const typePsets: PropertySet[] = [
    { name: 'Pset_WallCommon', globalId: 'type-pset-1', properties: [
      { name: 'FireRating', type: 0, value: 'REI 60' },
      { name: 'Manufacturer', type: 0, value: 'ACME Walls' },
    ] },
  ];
  const typeQsets: QuantitySet[] = [
    { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Width', value: 0.2, type: 0 }] },
  ];

  return {
    getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1, 2] : []),
    getEntityName: (id) => `Wall-${id}`,
    getEntityGlobalId: (id) => `guid-${id}`,
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: () => 'IfcWall',
    getPropertySets: (id) => instancePsets.get(id) ?? [],
    getQuantitySets: (id) => instanceQsets.get(id) ?? [],
    getTypePropertySets: () => typePsets,
    getTypeQuantitySets: () => typeQsets,
  };
}

function walls(columns: ListDefinition['columns'], conditions: ListDefinition['conditions'] = []): ListDefinition {
  return { id: 't', name: 'T', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], conditions, columns };
}

describe('type-property fallback (#1745)', () => {
  it('resolves a type-only property on every instance row', () => {
    const result = executeList(
      walls([{ id: 'mfr', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'Manufacturer' }]),
      createProvider(),
    );
    expect(result.rows.map(r => r.values[0])).toEqual(['ACME Walls', 'ACME Walls']);
  });

  it('lets an instance value win over the type default', () => {
    const result = executeList(
      walls([{ id: 'fr', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating' }]),
      createProvider(),
    );
    // Wall 1 overrides locally (REI 120); Wall 2 falls back to the type (REI 60).
    expect(result.rows.map(r => r.values[0])).toEqual(['REI 120', 'REI 60']);
  });

  it('resolves a type-only quantity on every instance row', () => {
    const result = executeList(
      walls([{ id: 'w', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Width' }]),
      createProvider(),
    );
    expect(result.rows.map(r => r.values[0])).toEqual([0.2, 0.2]);
    // The result column carries the QuantityType derived from the type QTO.
    expect(result.columns[0].quantityType).toBe(0);
  });

  it('does not shadow a local quantity with the type', () => {
    const result = executeList(
      walls([{ id: 'l', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Length' }]),
      createProvider(),
    );
    expect(result.rows.map(r => r.values[0])).toEqual([5, 3]);
  });

  it('filters on a type-inherited property value', () => {
    const result = executeList(
      walls(
        [{ id: 'mfr', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'Manufacturer' }],
        [{ source: 'property', psetName: 'Pset_WallCommon', propertyName: 'Manufacturer', operator: 'equals', value: 'ACME Walls' }],
      ),
      createProvider(),
    );
    expect(result.totalCount).toBe(2);
  });

  it('does not fall back when the instance declares the property (even null-valued)', () => {
    // Deliberate precedence choice (#1745): fallback is ENTRY-based, not
    // value-based — an occurrence that declares the property overrides the
    // type, matching IFC occurrence-override semantics and the engine's
    // instance-only behaviour. A present-but-null occurrence property therefore
    // wins (resolves blank) rather than surfacing the type default.
    const base = createProvider();
    const withNull: ListDataProvider = {
      ...base,
      getPropertySets: (id) => id === 2
        ? [{ name: 'Pset_WallCommon', globalId: 'inst-2', properties: [{ name: 'FireRating', type: 0, value: null }] }]
        : base.getPropertySets(id),
    };
    const result = executeList(
      walls([{ id: 'fr', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating' }]),
      withNull,
    );
    // Wall 2 declares FireRating locally (null) → stays null, no REI 60 from the type.
    expect(result.rows.map(r => r.values[0])).toEqual(['REI 120', null]);
  });

  it('degrades gracefully when the provider has no type accessors', () => {
    const base = createProvider();
    const noType: ListDataProvider = { ...base, getTypePropertySets: undefined, getTypeQuantitySets: undefined };
    const result = executeList(
      walls([{ id: 'mfr', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'Manufacturer' }]),
      noType,
    );
    // No type source available → type-only property stays blank, no throw.
    expect(result.rows.map(r => r.values[0])).toEqual([null, null]);
  });
});
