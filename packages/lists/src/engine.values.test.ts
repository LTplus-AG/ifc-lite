/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Value-level coverage for the list engine: cell-value resolution, sort
 * ordering, multi-valued (material / classification) condition operators,
 * grouping bookkeeping and column discovery.
 *
 * Every case here was written against a mutation that survived the
 * pre-existing suite. The shared `engine.test.ts` fixture carries no
 * numeric typed-array property, no repeated material layer, no null
 * cell and no equal-count groups, so those branches were structurally
 * unreachable from it.
 */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum } from '@ifc-lite/data';
import { executeList, listResultToCSV, summariseListRows, groupingColumnIds } from './engine.js';
import { discoverColumns } from './discovery.js';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { ListDataProvider, ListDefinition, ListRow } from './types.js';

// ============================================================================
// Fixtures
// ============================================================================

interface EntitySpec {
  name: string;
  type: string;
  psets?: Array<{ name: string; globalId: string; properties: Array<{ name: string; type: string; value: unknown; dataType?: string }> }>;
  qsets?: Array<{ name: string; globalId: string; quantities: Array<{ name: string; value: number; type: number }> }>;
  materials?: string[];
  classifications?: Array<{ system?: string; code?: string; name?: string }>;
  storey?: string;
}

/** Minimal provider over an explicit id → spec table. */
function providerOver(specs: Map<number, EntitySpec>): ListDataProvider {
  const byType = new Map<string, number[]>();
  for (const [id, spec] of specs) {
    const list = byType.get(spec.type);
    if (list) list.push(id);
    else byType.set(spec.type, [id]);
  }
  const provider: ListDataProvider = {
    getEntitiesByType: (type) => byType.get(IfcTypeEnum[type] ?? '') ?? [],
    getEntityName: (id) => specs.get(id)?.name ?? '',
    getEntityGlobalId: () => '',
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: (id) => specs.get(id)?.type ?? '',
    getPropertySets: (id) => (specs.get(id)?.psets ?? []) as unknown as PropertySet[],
    getQuantitySets: (id) => (specs.get(id)?.qsets ?? []) as unknown as QuantitySet[],
    getAllEntityIds: () => Array.from(specs.keys()),
    getMaterialNames: (id) => specs.get(id)?.materials ?? [],
    getClassifications: (id) => specs.get(id)?.classifications ?? [],
    getStoreyName: (id) => specs.get(id)?.storey ?? '',
  };
  return provider;
}

const def = (over: Partial<ListDefinition>): ListDefinition => ({
  id: 'd', name: 'D', createdAt: 0, updatedAt: 0,
  entityTypes: [IfcTypeEnum.IfcWall], conditions: [], columns: [],
  ...over,
});

const names = (rows: ListRow[], i = 0): unknown[] => rows.map((r) => r.values[i]);

// ============================================================================
// Cell-value resolution (resolvePropertyValue)
// ============================================================================

describe('property cell values keep their numeric identity', () => {
  // `[IFCREAL, 5.3]` is the canonical typed-value wire shape a STEP parser
  // hands the provider. If it resolved to the DISPLAY string "5.3" instead
  // of the number 5.3, every downstream numeric use silently degrades:
  // group sums skip it (`typeof v === 'number'`), and sorting goes
  // lexicographic ("10" < "9"). The pre-existing fixture only ever carries
  // `[IFCBOOLEAN, '.T.']`, whose second element is a string — so the
  // numeric-unwrap branch never ran.
  const typedNumeric = new Map<number, EntitySpec>([
    [1, { name: 'W1', type: 'IfcWall', psets: [{ name: 'Pset_X', globalId: 'ps', properties: [{ name: 'U', type: 'single', value: ['IFCREAL', 5.3] }] }] }],
    [2, { name: 'W2', type: 'IfcWall', psets: [{ name: 'Pset_X', globalId: 'ps', properties: [{ name: 'U', type: 'single', value: ['IFCREAL', 10.5] }] }] }],
  ]);

  it('unwraps a typed numeric array to the raw number, not its display string', () => {
    const result = executeList(def({
      columns: [{ id: 'u', source: 'property', psetName: 'Pset_X', propertyName: 'U' }],
    }), providerOver(typedNumeric));

    const values = names(result.rows).sort();
    expect(values).toEqual([10.5, 5.3]);
    for (const v of values) expect(typeof v).toBe('number');
  });

  it('sums a typed numeric property into group totals', () => {
    const result = executeList(def({
      columns: [
        { id: 'k', source: 'attribute', propertyName: 'Class' },
        { id: 'u', source: 'property', psetName: 'Pset_X', propertyName: 'U' },
      ],
      grouping: { columnId: 'k', sumColumnIds: ['u'] },
    }), providerOver(typedNumeric));

    expect(result.summary?.sums.u).toBeCloseTo(15.8, 10);
  });

  it('keeps a raw numeric property a number rather than its formatted string', () => {
    const result = executeList(def({
      columns: [{ id: 'u', source: 'property', psetName: 'Pset_X', propertyName: 'U' }],
    }), providerOver(new Map([
      [1, { name: 'W1', type: 'IfcWall', psets: [{ name: 'Pset_X', globalId: 'ps', properties: [{ name: 'U', type: 'single', value: 0.24 }] }] }],
    ])));

    expect(result.rows[0].values[0]).toBe(0.24);
    expect(typeof result.rows[0].values[0]).toBe('number');
  });

  it('maps the em-dash null indicator to a real null cell', () => {
    // `'IFCLABEL,'` (a typed value with an empty payload) is what
    // `parsePropertyValue` renders as an em-dash. The engine must turn
    // that back into null, otherwise a blank cell exports as "—" and
    // `exists` conditions treat the property as present.
    const result = executeList(def({
      columns: [{ id: 'p', source: 'property', psetName: 'Pset_X', propertyName: 'P' }],
    }), providerOver(new Map([
      [1, { name: 'W1', type: 'IfcWall', psets: [{ name: 'Pset_X', globalId: 'ps', properties: [{ name: 'P', type: 'single', value: 'IFCLABEL,' }] }] }],
    ])));

    expect(result.rows[0].values[0]).toBeNull();
  });

  it('renders a native boolean through the shared display mapping (True/False, not true/false)', () => {
    const result = executeList(def({
      columns: [
        { id: 't', source: 'property', psetName: 'Pset_X', propertyName: 'T' },
        { id: 'f', source: 'property', psetName: 'Pset_X', propertyName: 'F' },
      ],
    }), providerOver(new Map([
      [1, { name: 'W1', type: 'IfcWall', psets: [{ name: 'Pset_X', globalId: 'ps', properties: [
        { name: 'T', type: 'single', value: true }, { name: 'F', type: 'single', value: false },
      ] }] }],
    ])));

    expect(result.rows[0].values).toEqual(['True', 'False']);
  });
});

describe('multi-valued cell values are de-duplicated', () => {
  // An element repeats a material across layers (a sandwich wall with two
  // concrete leaves). The cell must name it once — the fixture in
  // engine.test.ts has no repeated layer, so the de-dup was an identity.
  it('collapses a material repeated across layers into one mention', () => {
    const result = executeList(def({
      columns: [{ id: 'm', source: 'material', propertyName: 'Material' }],
    }), providerOver(new Map([
      [1, { name: 'W1', type: 'IfcWall', materials: ['Concrete', 'Insulation', 'Concrete'] }],
    ])));

    expect(result.rows[0].values[0]).toBe('Concrete, Insulation');
  });

  it('collapses a classification code repeated across refs', () => {
    const result = executeList(def({
      columns: [{ id: 'c', source: 'classification', propertyName: 'Classification' }],
    }), providerOver(new Map([
      [1, { name: 'W1', type: 'IfcWall', classifications: [
        { system: 'U', code: 'Pr_20' }, { system: 'V', code: 'Pr_20' }, { system: 'U', code: 'Ss_30' },
      ] }] as [number, EntitySpec],
    ])));

    expect(result.rows[0].values[0]).toBe('Pr_20, Ss_30');
  });
});

// ============================================================================
// Sorting
// ============================================================================

describe('sort ordering', () => {
  // 9 vs 10: the only pair that separates a numeric compare from the
  // lexicographic fallback. The suite's only sort test sorted names.
  const numeric = new Map<number, EntitySpec>([
    [1, { name: 'A', type: 'IfcWall', qsets: [{ name: 'Qto_W', globalId: 'qs', quantities: [{ name: 'L', value: 9, type: 0 }] }] }],
    [2, { name: 'B', type: 'IfcWall', qsets: [{ name: 'Qto_W', globalId: 'qs', quantities: [{ name: 'L', value: 10, type: 0 }] }] }],
    [3, { name: 'C', type: 'IfcWall', qsets: [{ name: 'Qto_W', globalId: 'qs', quantities: [{ name: 'L', value: 100, type: 0 }] }] }],
  ]);
  const numericDef = (direction: 'asc' | 'desc') => def({
    columns: [{ id: 'l', source: 'quantity', psetName: 'Qto_W', propertyName: 'L' }],
    sortBy: { columnId: 'l', direction },
  });

  it('orders numeric cells by magnitude, not lexicographically', () => {
    const result = executeList(numericDef('asc'), providerOver(numeric));
    expect(names(result.rows)).toEqual([9, 10, 100]);
  });

  it('reverses that order for desc', () => {
    const result = executeList(numericDef('desc'), providerOver(numeric));
    expect(names(result.rows)).toEqual([100, 10, 9]);
  });

  // Null cells (missing property) sort BEFORE every value ascending, and
  // therefore after every value descending. Both null branches of
  // `compareCellValues` were unexercised: the suite never sorted a column
  // that had a blank cell.
  const withNulls = new Map<number, EntitySpec>([
    [1, { name: 'A', type: 'IfcWall', psets: [{ name: 'Pset_X', globalId: 'ps', properties: [{ name: 'P', type: 'single', value: 'beta' }] }] }],
    [2, { name: 'B', type: 'IfcWall' }],
    [3, { name: 'C', type: 'IfcWall', psets: [{ name: 'Pset_X', globalId: 'ps', properties: [{ name: 'P', type: 'single', value: 'alpha' }] }] }],
  ]);
  const nullDef = (direction: 'asc' | 'desc') => def({
    columns: [{ id: 'p', source: 'property', psetName: 'Pset_X', propertyName: 'P' }],
    sortBy: { columnId: 'p', direction },
  });

  it('sorts null cells first ascending', () => {
    const result = executeList(nullDef('asc'), providerOver(withNulls));
    expect(names(result.rows)).toEqual([null, 'alpha', 'beta']);
  });

  it('sorts null cells last descending', () => {
    const result = executeList(nullDef('desc'), providerOver(withNulls));
    expect(names(result.rows)).toEqual(['beta', 'alpha', null]);
  });
});

// ============================================================================
// Material / classification condition operators
// ============================================================================

describe('multi-valued condition operators (material, classification)', () => {
  // `equals` is an ANY-match over the element's materials; `notEquals` is
  // an ALL-differ (an element with ANY matching layer is excluded). The
  // pre-existing suite covered only `contains` and `exists`, so both
  // operators' bodies were free.
  const provider = providerOver(new Map<number, EntitySpec>([
    [1, { name: 'W1', type: 'IfcWall', materials: ['Concrete'], classifications: [{ code: 'Pr_20' }] }],
    [2, { name: 'W2', type: 'IfcWall', materials: ['Brick', 'Concrete'], classifications: [{ name: 'Wall' }] }],
    [3, { name: 'W3', type: 'IfcWall', materials: ['Timber'], classifications: [] }],
  ]));
  const condDef = (
    source: 'material' | 'classification',
    operator: 'equals' | 'notEquals',
    value: string,
  ) => def({
    entityTypes: [], conditions: [{ source, propertyName: source, operator, value }],
    columns: [{ id: 'n', source: 'attribute', propertyName: 'Name' }],
  });

  it('material equals matches an element with that layer among several', () => {
    const rows = executeList(condDef('material', 'equals', 'Concrete'), provider).rows;
    expect(names(rows).sort()).toEqual(['W1', 'W2']);
  });

  it('material equals is a WHOLE-value match, not a substring one', () => {
    // 'Concret' is a prefix of 'Concrete': `contains` would match, `equals`
    // must not. This is what separates the two operators.
    expect(executeList(condDef('material', 'equals', 'Concret'), provider).rows).toHaveLength(0);
  });

  it('material notEquals excludes an element carrying the value on ANY layer', () => {
    const rows = executeList(condDef('material', 'notEquals', 'Concrete'), provider).rows;
    // W2 has Brick AND Concrete — one non-matching layer must not save it.
    expect(names(rows)).toEqual(['W3']);
  });

  it('classification equals matches by code or by name', () => {
    expect(names(executeList(condDef('classification', 'equals', 'Pr_20'), provider).rows)).toEqual(['W1']);
    expect(names(executeList(condDef('classification', 'equals', 'Wall'), provider).rows)).toEqual(['W2']);
  });

  it('classification notEquals still drops the element with no classification at all', () => {
    // Documented semantics: an element with no candidates never matches,
    // notEquals included.
    const rows = executeList(condDef('classification', 'notEquals', 'Pr_20'), provider).rows;
    expect(names(rows)).toEqual(['W2']);
  });
});

// ============================================================================
// Grouping bookkeeping
// ============================================================================

describe('grouping bookkeeping', () => {
  it('drops empty-string group ids instead of grouping on a nameless column', () => {
    // The viewer persists `columnIds: ['']` for a cleared group chip; an
    // empty id must not survive into the level list, or `findIndex` returns
    // -1 and every row lands in one synthetic "(none)" bucket.
    expect(groupingColumnIds({ columnId: '', columnIds: ['', 'a', ''], sumColumnIds: [] })).toEqual(['a']);
    expect(groupingColumnIds({ columnId: '', sumColumnIds: [] })).toEqual([]);
  });

  it('breaks an equal-count tie by label so group order is deterministic', () => {
    // Two groups of the same size: without the localeCompare tiebreak the
    // order is whichever label the rows happened to introduce first, so the
    // same model re-executed after a filter change reorders the schedule.
    const definition = def({
      columns: [{ id: 'k', source: 'attribute', propertyName: 'Name' }],
      grouping: { columnId: 'k', sumColumnIds: [] },
    });
    const rows: ListRow[] = [
      { entityId: 1, modelId: 'm', values: ['Zulu'] },
      { entityId: 2, modelId: 'm', values: ['Alpha'] },
      { entityId: 3, modelId: 'm', values: ['Zulu'] },
      { entityId: 4, modelId: 'm', values: ['Alpha'] },
    ];

    const { groups } = summariseListRows(definition, rows);
    expect(groups?.map((g) => g.label)).toEqual(['Alpha', 'Zulu']);
  });

  it('excludes non-finite cells from group and overall sums', () => {
    // A quantity that arrives as Infinity/NaN (a degenerate geometry, a
    // divide-by-zero in a provider) must not poison the total — a NaN sum
    // renders as an empty or "NaN" cell in the schedule and its export.
    const definition = def({
      columns: [
        { id: 'k', source: 'attribute', propertyName: 'Class' },
        { id: 'v', source: 'quantity', psetName: 'Q', propertyName: 'V' },
      ],
      grouping: { columnId: 'k', sumColumnIds: ['v'] },
    });
    const rows: ListRow[] = [
      { entityId: 1, modelId: 'm', values: ['IfcWall', 2] },
      { entityId: 2, modelId: 'm', values: ['IfcWall', Number.NaN] },
      { entityId: 3, modelId: 'm', values: ['IfcWall', Number.POSITIVE_INFINITY] },
      { entityId: 4, modelId: 'm', values: ['IfcWall', 3] },
    ];

    const { groups, summary } = summariseListRows(definition, rows);
    expect(summary?.sums.v).toBe(5);
    expect(groups?.[0].sums.v).toBe(5);
  });
});

// ============================================================================
// Column discovery
// ============================================================================

describe('discoverColumns', () => {
  /** 60 walls: #0 and #1 carry different props; #55 carries a distinctive one. */
  function manyWalls(): ListDataProvider {
    const specs = new Map<number, EntitySpec>();
    for (let i = 0; i < 60; i++) {
      specs.set(i + 1, {
        name: `W${i}`,
        type: 'IfcWall',
        psets: [{ name: 'Pset_WallCommon', globalId: 'ps', properties: [{ name: `P${i}`, type: 'single', value: i }] }],
      });
    }
    return providerOver(specs);
  }

  it('samples beyond the first entity of a type', () => {
    // A one-entity sample would report only the first element's schema, so
    // a property that lives on every OTHER wall would be missing from the
    // column picker entirely.
    const result = discoverColumns(manyWalls(), [IfcTypeEnum.IfcWall]);
    const props = result.properties.get('Pset_WallCommon') ?? [];
    expect(props).toContain('P0');
    expect(props).toContain('P1');
    expect(props).toContain('P49');
  });

  it('caps the sample at 50 entities per type per provider', () => {
    // The cap is the whole point of the module (100K-entity models): if it
    // is removed, discovery walks every element and the picker stalls. The
    // observable consequence is that properties unique to element 51+ do
    // NOT appear.
    const result = discoverColumns(manyWalls(), [IfcTypeEnum.IfcWall]);
    const props = result.properties.get('Pset_WallCommon') ?? [];
    expect(props).toHaveLength(50);
    expect(props).not.toContain('P50');
    expect(props).not.toContain('P59');
  });

  it('returns property and quantity names sorted for a stable picker', () => {
    const provider = providerOver(new Map<number, EntitySpec>([
      [1, {
        name: 'W', type: 'IfcWall',
        psets: [{ name: 'Pset_WallCommon', globalId: 'ps', properties: [
          { name: 'Zeta', type: 'single', value: 1 }, { name: 'Alpha', type: 'single', value: 2 }, { name: 'Mu', type: 'single', value: 3 },
        ] }],
        qsets: [{ name: 'Qto_W', globalId: 'qs', quantities: [
          { name: 'Width', value: 1, type: 0 }, { name: 'Area', value: 2, type: 1 }, { name: 'Length', value: 3, type: 0 },
        ] }],
      }],
    ]));

    const result = discoverColumns(provider, [IfcTypeEnum.IfcWall]);
    expect(result.properties.get('Pset_WallCommon')).toEqual(['Alpha', 'Mu', 'Zeta']);
    expect(result.quantities.get('Qto_W')).toEqual(['Area', 'Length', 'Width']);
  });

  it('skips nameless property and quantity sets instead of emitting a blank bucket', () => {
    const provider = providerOver(new Map<number, EntitySpec>([
      [1, {
        name: 'W', type: 'IfcWall',
        psets: [{ name: '', globalId: 'ps', properties: [{ name: 'Orphan', type: 'single', value: 1 }] }],
        qsets: [{ name: '', globalId: 'qs', quantities: [{ name: 'Orphan', value: 1, type: 0 }] }],
      }],
    ]));

    const result = discoverColumns(provider, [IfcTypeEnum.IfcWall]);
    expect(result.properties.has('')).toBe(false);
    expect(result.quantities.has('')).toBe(false);
    expect(result.properties.size).toBe(0);
    expect(result.quantities.size).toBe(0);
  });
});

// ============================================================================
// CSV headers
// ============================================================================

describe('listResultToCSV headers', () => {
  it('qualifies an unlabelled column with its set name', () => {
    // Two columns can share a property name across different sets (the
    // canonical case: NetVolume in Qto_WallBaseQuantities and in
    // Qto_SlabBaseQuantities). Without the `Set.Prop` fallback the export
    // has two identical headers and the recipient cannot tell them apart.
    const csv = listResultToCSV({
      columns: [
        { id: 'a', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetVolume' },
        { id: 'b', source: 'quantity', psetName: 'Qto_SlabBaseQuantities', propertyName: 'NetVolume' },
        { id: 'c', source: 'attribute', propertyName: 'Name' },
      ],
      rows: [],
      totalCount: 0,
      executionTime: 0,
    });

    expect(csv.split('\n')[0]).toBe(
      'Qto_WallBaseQuantities.NetVolume,Qto_SlabBaseQuantities.NetVolume,Name',
    );
  });
});
