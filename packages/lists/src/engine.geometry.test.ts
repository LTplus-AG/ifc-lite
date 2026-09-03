/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World Coordinate column/condition support (issue #3671) — "Reporting
 * World Coordinates in Lists". The `geometry` source resolves to one axis of
 * the element's fully-composed PROJECT-space placement (the resolved
 * `IfcLocalPlacement` chain), NOT the map/WGS84 georeferenced frame — that
 * distinction is enforced by the viewer-side `getWorldPosition` provider
 * hook, not tested here; this only exercises the engine's resolution of
 * whatever `{x,y,z}` the provider reports.
 */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum, QuantityType } from '@ifc-lite/data';
import { executeList } from './engine.js';
import type { ListDataProvider, ListDefinition } from './types.js';

type Pos = { x: number; y: number; z: number };

function createProvider(positions: Map<number, Pos>): ListDataProvider {
  return {
    getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1, 2, 3] : []),
    getEntityName: (id) => `Wall-${id}`,
    getEntityGlobalId: (id) => `guid-${id}`,
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: () => 'IfcWall',
    getPropertySets: () => [],
    getQuantitySets: () => [],
    getWorldPosition: (id) => positions.get(id) ?? null,
  };
}

function walls(columns: ListDefinition['columns'], conditions: ListDefinition['conditions'] = []): ListDefinition {
  return { id: 't', name: 'T', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], conditions, columns };
}

describe('geometry (World Coordinate) column/condition (#3671)', () => {
  const positions = new Map<number, Pos>([
    [1, { x: 100.5, y: -25.25, z: 3.1 }],
    [2, { x: -500, y: 12000, z: -7.5 }],
    [3, { x: 0, y: 0, z: 0 }],
  ]);

  it('resolves the X axis by default', () => {
    // Empty axis, not 'X': this is the default branch in getWorldCoordinateValue.
    // With 'X' the explicit case answers and an implementation that defaulted to
    // Y would still pass, so the test would not name the mutation it kills.
    const result = executeList(walls([{ id: 'g', source: 'geometry', propertyName: '' }]), createProvider(positions));
    expect(result.rows.find(r => r.entityId === 1)!.values[0]).toBe(100.5);
  });

  it('an axis that is not X/Y/Z resolves to null, not to X (#3734)', () => {
    // `case 'X'` and `default` used to share a body, so a column whose axis is
    // anything else reported the X coordinate under a header saying something
    // else. A blank cell is a visible gap; a plausible number under the wrong
    // label is a wrong answer that reads as a right one.
    const result = executeList(walls([{ id: 'g', source: 'geometry', propertyName: 'Q' }]), createProvider(positions));
    expect(result.rows.find(r => r.entityId === 1)!.values[0]).toBeNull();
  });

  it('a blank axis still means X, which is the documented default (#3734)', () => {
    // The narrowing above must not swallow the default. Whitespace-only counts
    // as absent, matching how a blank name is treated elsewhere in the repo.
    for (const axis of ['', '  ', '\t']) {
      const result = executeList(walls([{ id: 'g', source: 'geometry', propertyName: axis }]), createProvider(positions));
      expect(result.rows.find(r => r.entityId === 1)!.values[0], `axis ${JSON.stringify(axis)}`).toBe(100.5);
    }
  });

  it('an unknown-axis CONDITION matches nothing, including exists (#3734)', () => {
    // The same resolver backs conditions, so narrowing the cell narrows the
    // filter too. `exists` is the one worth pinning: it now answers "no element
    // has a world position" for a bad axis, which is chosen behaviour, not
    // inherited. The builder cannot construct a geometry condition at all, so
    // this is reachable only from a hand-edited or imported definition.
    const unknown = (operator: 'exists' | 'equals', value?: number) =>
      executeList(
        walls([{ id: 'g', source: 'geometry', propertyName: 'X' }], [
          { id: 'c', source: 'geometry', propertyName: 'Q', operator, value } as never,
        ]),
        createProvider(positions),
      ).rows.length;
    expect(unknown('exists')).toBe(0);
    expect(unknown('equals', 100.5)).toBe(0);

    // A known axis still filters, so the zero above is the axis and not a
    // condition path that stopped working.
    const known = executeList(
      walls([{ id: 'g', source: 'geometry', propertyName: 'X' }], [
        { id: 'c', source: 'geometry', propertyName: 'X', operator: 'equals', value: 100.5 } as never,
      ]),
      createProvider(positions),
    );
    expect(known.rows.length).toBe(1);
  });

  it('resolves the Y axis', () => {
    const result = executeList(walls([{ id: 'g', source: 'geometry', propertyName: 'Y' }]), createProvider(positions));
    expect(result.rows.find(r => r.entityId === 1)!.values[0]).toBe(-25.25);
  });

  it('resolves the Z axis', () => {
    const result = executeList(walls([{ id: 'g', source: 'geometry', propertyName: 'Z' }]), createProvider(positions));
    expect(result.rows.find(r => r.entityId === 1)!.values[0]).toBe(3.1);
  });

  it('matches the axis case-insensitively', () => {
    const result = executeList(walls([{ id: 'g', source: 'geometry', propertyName: 'y' }]), createProvider(positions));
    expect(result.rows.find(r => r.entityId === 1)!.values[0]).toBe(-25.25);
  });

  it('tags the column as a Length quantity so the unit resolver converts it', () => {
    const result = executeList(walls([{ id: 'g', source: 'geometry', propertyName: 'X' }]), createProvider(positions));
    expect(result.columns[0]!.quantityType).toBe(QuantityType.Length);
  });

  it('a provider with no getWorldPosition resolves every geometry column to null (backward compatible)', () => {
    const provider: ListDataProvider = {
      getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1] : []),
      getEntityName: () => 'Wall-1',
      getEntityGlobalId: () => 'guid-1',
      getEntityDescription: () => '',
      getEntityObjectType: () => '',
      getEntityTag: () => '',
      getEntityTypeName: () => 'IfcWall',
      getPropertySets: () => [],
      getQuantitySets: () => [],
    };
    expect(provider.getWorldPosition).toBeUndefined();
    const result = executeList(walls([{ id: 'g', source: 'geometry', propertyName: 'X' }]), provider);
    expect(result.rows.every(r => r.values[0] === null)).toBe(true);
    // No value ever resolved -> the column carries no derived quantityType.
    expect(result.columns[0]!.quantityType).toBeUndefined();
  });

  it('sorts a geometry column numerically ascending, mixed signs included', () => {
    const def = walls([{ id: 'g', source: 'geometry', propertyName: 'X' }]);
    def.sortBy = { columnId: 'g', direction: 'asc' };
    const result = executeList(def, createProvider(positions));
    // x values: 1 -> 100.5, 2 -> -500, 3 -> 0
    expect(result.rows.map(r => r.entityId)).toEqual([2, 3, 1]);
  });

  it('sorts a geometry column numerically descending', () => {
    const def = walls([{ id: 'g', source: 'geometry', propertyName: 'X' }]);
    def.sortBy = { columnId: 'g', direction: 'desc' };
    const result = executeList(def, createProvider(positions));
    expect(result.rows.map(r => r.entityId)).toEqual([1, 3, 2]);
  });

  it('filters rows via a geometry gt condition', () => {
    const result = executeList(
      walls([{ id: 'g', source: 'geometry', propertyName: 'X' }], [
        { source: 'geometry', propertyName: 'X', operator: 'gt', value: 50 },
      ]),
      createProvider(positions),
    );
    expect(result.rows.map(r => r.entityId)).toEqual([1]);
  });

  it('filters rows via a geometry lt condition', () => {
    const result = executeList(
      walls([{ id: 'g', source: 'geometry', propertyName: 'X' }], [
        { source: 'geometry', propertyName: 'X', operator: 'lt', value: 0 },
      ]),
      createProvider(positions),
    );
    expect(result.rows.map(r => r.entityId)).toEqual([2]);
  });
});
