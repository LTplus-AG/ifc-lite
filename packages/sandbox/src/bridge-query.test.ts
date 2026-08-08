/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.query` had zero behavioural coverage: `bridge-permissions.test.ts`
 * only checks `typeof bim.query`, never invoking a `call:` handler.
 *
 * Every method that accepts an entity ref guards it through `toRef` and
 * falls back to either `[]` (array-typed returns) or `null`/an empty
 * composite (single-value / non-nullable composite returns) when the ref is
 * unusable. That fallback shape is the one place these 17 near-identical
 * methods could silently diverge from their own declared `tsReturn` type —
 * this file pins each fallback against an invalid ref, and pins that a
 * valid ref reaches the underlying SDK call unmodified.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BimContext, EntityData, EntityRef } from '@ifc-lite/sdk';
import { buildQueryNamespace } from './bridge-query.js';

function findMethod(name: string) {
  const method = buildQueryNamespace().methods.find((m) => m.name === name);
  if (!method) throw new Error(`no such method: ${name}`);
  return method;
}

const REF: EntityRef = { modelId: 'm1', expressId: 7 };
const DUMPED_ENTITY = { ref: REF, name: 'Wall' };
const ENTITY: EntityData = {
  ref: REF,
  globalId: 'g1',
  name: 'Basic Wall',
  type: 'IfcWall',
  description: '',
  objectType: '',
};

function mockSdk(overrides: Partial<BimContext> = {}): BimContext {
  return {
    query: vi.fn(),
    matchingActiveFilter: vi.fn(),
    entity: vi.fn(),
    attributes: vi.fn(),
    properties: vi.fn(),
    quantities: vi.fn(),
    property: vi.fn(),
    classifications: vi.fn(),
    materials: vi.fn(),
    typeProperties: vi.fn(),
    documents: vi.fn(),
    relationships: vi.fn(),
    quantity: vi.fn(),
    related: vi.fn(),
    containedIn: vi.fn(),
    contains: vi.fn(),
    decomposedBy: vi.fn(),
    decomposes: vi.fn(),
    storey: vi.fn(),
    path: vi.fn(),
    storeys: vi.fn(),
    viewer: { getSelection: vi.fn(() => []) },
    ...overrides,
  } as unknown as BimContext;
}

describe('bim.query — invalid-ref fallback shape', () => {
  // Array-returning methods must fall back to [], matching their `T[]`
  // tsReturn — a `null` fallback here would violate the declared type for
  // any script that does `.map()` on the result without a null check.
  it.each([
    'attributes',
    'properties',
    'quantities',
    'classifications',
    'documents',
    'related',
    'contains',
    'decomposes',
    'path',
  ])('%s returns [] for an invalid ref, without calling the SDK', (name) => {
    const sdk = mockSdk();
    const method = findMethod(name);
    const args = name === 'related' ? [{}, 'IfcRelAggregates', 'forward'] : [{}];
    const result = method.call(sdk, args);
    expect(result).toEqual([]);
  });

  // Single-value-returning methods must fall back to null, matching their
  // `T | null` tsReturn.
  it.each([
    'property',
    'materials',
    'typeProperties',
    'quantity',
    'containedIn',
    'decomposedBy',
    'storey',
  ])('%s returns null for an invalid ref, without calling the SDK', (name) => {
    const sdk = mockSdk();
    const method = findMethod(name);
    const args = name === 'property' || name === 'quantity' ? [{}, 'Pset', 'Prop'] : [{}];
    const result = method.call(sdk, args);
    expect(result).toBeNull();
  });

  // `relationships`' tsReturn is the one non-nullable composite in the
  // family (`BimRelationships`, not `BimRelationships | null`), so its
  // fallback is a struct of empty arrays rather than null or []. Assert the
  // exact shape — a bare `{}` or a missing key would still be "falsy-ish"
  // under a looser assertion but would break a script reading `.voids`.
  it('relationships returns an all-empty struct for an invalid ref, without calling the SDK', () => {
    const sdk = mockSdk();
    const method = findMethod('relationships');
    const result = method.call(sdk, [{}]);
    expect(result).toEqual({ voids: [], fills: [], groups: [], connections: [] });
    expect(sdk.relationships).not.toHaveBeenCalled();
  });

  it('none of the array/null fallback methods call the underlying SDK method on an invalid ref', () => {
    const sdk = mockSdk();
    for (const name of [
      'attributes', 'properties', 'quantities', 'classifications', 'documents',
      'related', 'contains', 'decomposes', 'path',
      'property', 'materials', 'typeProperties', 'quantity', 'containedIn',
      'decomposedBy', 'storey',
    ]) {
      const method = findMethod(name);
      const args = name === 'related'
        ? [{}, 'IfcRelAggregates', 'forward']
        : name === 'property' || name === 'quantity'
          ? [{}, 'Pset', 'Prop']
          : [{}];
      method.call(sdk, args);
    }
    expect(sdk.attributes).not.toHaveBeenCalled();
    expect(sdk.properties).not.toHaveBeenCalled();
    expect(sdk.quantities).not.toHaveBeenCalled();
    expect(sdk.classifications).not.toHaveBeenCalled();
    expect(sdk.documents).not.toHaveBeenCalled();
    expect(sdk.related).not.toHaveBeenCalled();
    expect(sdk.contains).not.toHaveBeenCalled();
    expect(sdk.decomposes).not.toHaveBeenCalled();
    expect(sdk.path).not.toHaveBeenCalled();
    expect(sdk.property).not.toHaveBeenCalled();
    expect(sdk.materials).not.toHaveBeenCalled();
    expect(sdk.typeProperties).not.toHaveBeenCalled();
    expect(sdk.quantity).not.toHaveBeenCalled();
    expect(sdk.containedIn).not.toHaveBeenCalled();
    expect(sdk.decomposedBy).not.toHaveBeenCalled();
    expect(sdk.storey).not.toHaveBeenCalled();
  });
});

describe('bim.query — valid ref reaches the SDK', () => {
  it('attributes forwards the resolved ref to sdk.attributes', () => {
    const sdk = mockSdk({ attributes: vi.fn(() => [{ name: 'Tag', value: 'x' }]) as any });
    const result = findMethod('attributes').call(sdk, [DUMPED_ENTITY]);
    expect(sdk.attributes).toHaveBeenCalledWith(REF);
    expect(result).toEqual([{ name: 'Tag', value: 'x' }]);
  });

  it('storey unwraps ref, calls sdk.storey, and re-aliases a non-null result', () => {
    const sdk = mockSdk({ storey: vi.fn(() => ENTITY) as any });
    const result = findMethod('storey').call(sdk, [DUMPED_ENTITY]) as Record<string, unknown>;
    expect(sdk.storey).toHaveBeenCalledWith(REF);
    expect(result.name).toBe('Basic Wall');
    expect(result.Name).toBe('Basic Wall');
  });
});

describe('bim.query.properties / bim.query.quantities — named-property mapping', () => {
  it('maps every property set through mapNamedProperties and dual name/Name, globalId/GlobalId keys', () => {
    const sdk = mockSdk({
      properties: vi.fn(() => [
        {
          name: 'Pset_WallCommon',
          globalId: 'gp1',
          properties: [{ name: 'IsExternal', value: true, type: 'IfcBoolean' }],
        },
      ]) as any,
    });
    const result = findMethod('properties').call(sdk, [DUMPED_ENTITY]) as any[];
    expect(result).toEqual([
      {
        name: 'Pset_WallCommon',
        Name: 'Pset_WallCommon',
        globalId: 'gp1',
        GlobalId: 'gp1',
        properties: [
          { name: 'IsExternal', Name: 'IsExternal', value: true, Value: true, NominalValue: true, type: 'IfcBoolean', Type: 'IfcBoolean' },
        ],
        Properties: [
          { name: 'IsExternal', Name: 'IsExternal', value: true, Value: true, NominalValue: true, type: 'IfcBoolean', Type: 'IfcBoolean' },
        ],
      },
    ]);
  });

  it('maps every quantity set through mapNamedProperties and dual name/Name keys', () => {
    const sdk = mockSdk({
      quantities: vi.fn(() => [
        { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 3.2, type: 'IfcLengthMeasure' }] },
      ]) as any,
    });
    const result = findMethod('quantities').call(sdk, [DUMPED_ENTITY]) as any[];
    expect(result).toEqual([
      {
        name: 'Qto_WallBaseQuantities',
        Name: 'Qto_WallBaseQuantities',
        quantities: [
          { name: 'Length', Name: 'Length', value: 3.2, Value: 3.2, NominalValue: 3.2, type: 'IfcLengthMeasure', Type: 'IfcLengthMeasure' },
        ],
        Quantities: [
          { name: 'Length', Name: 'Length', value: 3.2, Value: 3.2, NominalValue: 3.2, type: 'IfcLengthMeasure', Type: 'IfcLengthMeasure' },
        ],
      },
    ]);
  });
});

describe('bim.query.byType', () => {
  it('applies the type filter when types are given', () => {
    const byType = vi.fn().mockReturnThis();
    const toArray = vi.fn(() => [ENTITY]);
    const builder = { byType, toArray };
    const sdk = mockSdk({ query: vi.fn(() => builder) as any });
    const result = findMethod('byType').call(sdk, [['IfcWall']]);
    expect(byType).toHaveBeenCalledWith('IfcWall');
    expect((result as any[]).map((e) => e.name)).toEqual(['Basic Wall']);
  });

  it('skips the filter call entirely (returns everything unfiltered) when given zero types', () => {
    // Documented as "Filter by IFC type" but with an empty type list it is a
    // no-op passthrough to toArray() — worth pinning explicitly since it is
    // easy to mistake for "return []".
    const byType = vi.fn();
    const toArray = vi.fn(() => [ENTITY]);
    const builder = { byType, toArray };
    const sdk = mockSdk({ query: vi.fn(() => builder) as any });
    const result = findMethod('byType').call(sdk, [[]]);
    expect(byType).not.toHaveBeenCalled();
    expect((result as any[]).length).toBe(1);
  });
});

describe('bim.query.selection', () => {
  it('drops selection refs that no longer resolve to an entity', () => {
    const staleRef: EntityRef = { modelId: 'm1', expressId: 999 };
    const sdk = mockSdk({
      viewer: { getSelection: vi.fn(() => [REF, staleRef]) } as any,
      entity: vi.fn((ref: EntityRef) => (ref.expressId === 7 ? ENTITY : null)) as any,
    });
    const result = findMethod('selection').call(sdk, []) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].ref).toEqual(REF);
  });

  it('returns [] when nothing is selected', () => {
    const sdk = mockSdk({ viewer: { getSelection: vi.fn(() => []) } as any });
    const result = findMethod('selection').call(sdk, []);
    expect(result).toEqual([]);
  });
});

describe('bim.query.matchingActiveFilter', () => {
  it('returns null when no filter is active (matches the sdk value, not [])', () => {
    const sdk = mockSdk({ matchingActiveFilter: vi.fn(() => null) as any });
    expect(findMethod('matchingActiveFilter').call(sdk, [])).toBeNull();
  });

  it('re-aliases entities when a filter is active', () => {
    const sdk = mockSdk({ matchingActiveFilter: vi.fn(() => [ENTITY]) as any });
    const result = findMethod('matchingActiveFilter').call(sdk, []) as any[];
    expect(result[0].Name).toBe('Basic Wall');
  });
});

describe('bim.query.entity', () => {
  it('returns null for an unresolved (modelId, expressId) pair without ref validation', () => {
    const sdk = mockSdk({ entity: vi.fn(() => null) as any });
    const result = findMethod('entity').call(sdk, ['m1', 999]);
    expect(sdk.entity).toHaveBeenCalledWith({ modelId: 'm1', expressId: 999 });
    expect(result).toBeNull();
  });
});
