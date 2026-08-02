/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ADVERSARIAL tests for the Container spatial level (#1591 follow-up, PR #1700).
 * Each test pins a suspected failure mode down as CONFIRMED or REFUTED:
 *  - condition vs column value consistency (incl. the class-name fallback)
 *  - case sensitivity of Container conditions
 *  - matching behaviour for an EMPTY ('' / uncontained) container
 *  - legacy providers without getContainerName
 *  - level-string casing ('container' vs 'Container')
 *  - engine sortBy binding after an in-place column edit (same id, new def)
 *  - federated models sharing local express ids
 */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum } from '@ifc-lite/data';
import { executeList } from './engine.js';
import type { ListDataProvider, ListDefinition, PropertyCondition } from './types.js';

/**
 * Four walls with distinct container situations:
 *  1 -> 'Level 0'         (named storey container)
 *  2 -> 'Abutment East'   (named non-storey container)
 *  3 -> ''                (uncontained -> adapter returns '')
 *  4 -> 'IfcBridgePart'   (UNNAMED container: adapter already resolved the
 *                          class-name fallback, exactly what containerOf returns)
 */
function provider(containerNames: Map<number, string> = new Map([
  [1, 'Level 0'],
  [2, 'Abutment East'],
  [3, ''],
  [4, 'IfcBridgePart'],
])): ListDataProvider {
  const names = new Map([[1, 'W1'], [2, 'W2'], [3, 'W3'], [4, 'W4']]);
  return {
    getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1, 2, 3, 4] : []),
    getEntityName: (id) => names.get(id) ?? '',
    getEntityGlobalId: (id) => `g${id}`,
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: (id) => (names.has(id) ? 'IfcWall' : ''),
    getPropertySets: () => [],
    getQuantitySets: () => [],
    getAllEntityIds: () => [...names.keys()],
    getContainerName: (id) => containerNames.get(id) ?? '',
    getStoreyName: (id) => (id === 1 ? 'Level 0' : id === 2 ? 'Level 9' : ''),
  };
}

function defWith(conditions: PropertyCondition[], columns?: ListDefinition['columns']): ListDefinition {
  return {
    id: 'adv', name: 'adv', createdAt: 0, updatedAt: 0,
    entityTypes: [IfcTypeEnum.IfcWall],
    conditions,
    columns: columns ?? [
      { id: 'name', source: 'attribute', propertyName: 'Name' },
      { id: 'container', source: 'spatial', propertyName: 'Container' },
    ],
  };
}

const rowNames = (def: ListDefinition, p = provider()) =>
  executeList(def, p).rows.map((r) => r.values[0]).sort();

describe('Container condition vs column consistency', () => {
  it('the condition sees EXACTLY the value the column shows, including the class fallback', () => {
    // Column values first.
    const result = executeList(defWith([]), provider());
    const cells = new Map(result.rows.map((r) => [r.values[0], r.values[1]]));
    expect(cells.get('W1')).toBe('Level 0');
    expect(cells.get('W2')).toBe('Abutment East');
    expect(cells.get('W3')).toBeNull(); // '' coerced to null -> blank cell
    expect(cells.get('W4')).toBe('IfcBridgePart'); // class fallback IS the cell

    // A filter on the class-fallback value matches the same row the column
    // labels with it — no name-vs-class divergence between filter and column.
    expect(rowNames(defWith([
      { source: 'spatial', propertyName: 'Container', operator: 'equals', value: 'IfcBridgePart' },
    ]))).toEqual(['W4']);

    // And when the container HAS a real name, filtering by its class matches
    // NOTHING for that element: the condition sees the name, not the class.
    expect(rowNames(defWith([
      { source: 'spatial', propertyName: 'Container', operator: 'equals', value: 'IfcBuildingStorey' },
    ]))).toEqual([]);
  });
});

describe('Container condition case sensitivity', () => {
  it('equals is CASE-SENSITIVE (same as Storey/attribute equals)', () => {
    expect(rowNames(defWith([
      { source: 'spatial', propertyName: 'Container', operator: 'equals', value: 'abutment east' },
    ]))).toEqual([]);
    expect(rowNames(defWith([
      { source: 'spatial', propertyName: 'Container', operator: 'equals', value: 'Abutment East' },
    ]))).toEqual(['W2']);
  });

  it('contains is case-INSENSITIVE (same asymmetry as every scalar source)', () => {
    expect(rowNames(defWith([
      { source: 'spatial', propertyName: 'Container', operator: 'contains', value: 'ABUTMENT' },
    ]))).toEqual(['W2']);
  });
});

describe('empty-string container matching', () => {
  it('an uncontained element can NEVER be matched: equals "" fails (empty string -> null)', () => {
    expect(rowNames(defWith([
      { source: 'spatial', propertyName: 'Container', operator: 'equals', value: '' },
    ]))).toEqual([]);
  });

  it('notEquals also EXCLUDES uncontained elements (null short-circuits to false)', () => {
    // W3 has no container; "Container != Abutment East" still drops it.
    expect(rowNames(defWith([
      { source: 'spatial', propertyName: 'Container', operator: 'notEquals', value: 'Abutment East' },
    ]))).toEqual(['W1', 'W4']);
  });

  it('exists treats "" as absent, so it is the only (one-sided) uncontained probe', () => {
    expect(rowNames(defWith([
      { source: 'spatial', propertyName: 'Container', operator: 'exists', value: '' },
    ]))).toEqual(['W1', 'W2', 'W4']);
  });
});

describe('legacy provider without getContainerName', () => {
  const legacy = provider();
  delete (legacy as { getContainerName?: unknown }).getContainerName;

  it('the Container column resolves null (blank) instead of throwing', () => {
    const result = executeList(defWith([]), legacy);
    expect(result.rows.map((r) => r.values[1])).toEqual([null, null, null, null]);
  });

  it('a Container condition matches nothing instead of throwing', () => {
    const def = defWith([
      { source: 'spatial', propertyName: 'Container', operator: 'equals', value: 'Level 0' },
    ]);
    expect(executeList(def, legacy).rows).toEqual([]);
  });
});

describe('level-string is matched case-insensitively', () => {
  it("'container' (lowercase) resolves the Container level, not the storey fallback", () => {
    // FIXED: the level parser lower-cases the level string, so a hand-edited /
    // imported list carrying 'container' resolves the immediate-Container value
    // (getContainerName) instead of silently showing the storey name.
    const result = executeList(defWith([], [
      { id: 'name', source: 'attribute', propertyName: 'Name' },
      { id: 'c', source: 'spatial', propertyName: 'container' },
    ]), provider());
    const cells = new Map(result.rows.map((r) => [r.values[0], r.values[1]]));
    expect(cells.get('W2')).toBe('Abutment East'); // container, NOT the storey 'Level 9'
  });

  it('a genuinely unrecognised level still falls back to Storey (level-less legacy)', () => {
    // The back-compat default is untouched: an empty / unknown level resolves
    // the storey name, so lists authored before the level existed keep working.
    const result = executeList(defWith([], [
      { id: 'name', source: 'attribute', propertyName: 'Name' },
      { id: 'c', source: 'spatial', propertyName: '' },
    ]), provider());
    const cells = new Map(result.rows.map((r) => [r.values[0], r.values[1]]));
    expect(cells.get('W1')).toBe('Level 0'); // storey fallback
    expect(cells.get('W2')).toBe('Level 9');
  });
});

describe('engine sortBy binding across an in-place column edit', () => {
  it('sortBy.columnId keeps pointing at the edited slot and sorts the NEW values', () => {
    const p: ListDataProvider = {
      ...provider(),
      getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1, 2] : []),
      getQuantitySets: (id) => [{
        name: 'Qto_WallBaseQuantities',
        quantities: id === 1
          ? [{ name: 'Length', value: 5.0, type: 0 }, { name: 'Width', value: 0.1, type: 0 }]
          : [{ name: 'Length', value: 3.5, type: 0 }, { name: 'Width', value: 0.9, type: 0 }],
      }],
    };
    const before: ListDefinition = {
      id: 's', name: 's', createdAt: 0, updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall], conditions: [],
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
        { id: 'custom-quantity-Qto_WallBaseQuantities-Length', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Length' },
      ],
      sortBy: { columnId: 'custom-quantity-Qto_WallBaseQuantities-Length', direction: 'asc' },
    };
    // asc by Length: W2 (3.5) before W1 (5.0).
    expect(executeList(before, p).rows.map((r) => r.values[0])).toEqual(['W2', 'W1']);

    // In-place edit: same id (preserved by columnFromDraft), definition now Width.
    const after: ListDefinition = {
      ...before,
      columns: [
        before.columns[0],
        { ...before.columns[1], propertyName: 'Width', label: 'Width' },
      ],
    };
    // The sort binding (by id) survives and sorts by the NEW values:
    // asc by Width: W1 (0.1) before W2 (0.9).
    expect(executeList(after, p).rows.map((r) => r.values[0])).toEqual(['W1', 'W2']);
  });
});

describe('federated models with colliding express ids', () => {
  it('each model resolves the container from ITS OWN provider', () => {
    // Same local expressId 1 means a different element in each model.
    const pa = provider(new Map([[1, 'Level A']]));
    const pb = provider(new Map([[1, 'Pier West']]));
    const def = defWith([]);
    const ra = executeList(def, pa, 'model-a');
    const rb = executeList(def, pb, 'model-b');
    const cellA = ra.rows.find((r) => r.entityId === 1)!;
    const cellB = rb.rows.find((r) => r.entityId === 1)!;
    expect(cellA.values[1]).toBe('Level A');
    expect(cellB.values[1]).toBe('Pier West');
    // Merged rows (what ListPanel does) stay distinguishable by modelId.
    expect(cellA.modelId).toBe('model-a');
    expect(cellB.modelId).toBe('model-b');
  });
});
