/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Location-zone column/condition support (issue #1810). The `zone` source
 * bridges a viewer-computed classification (which zone box each element's
 * centroid falls into, plus a "straddles" flag when its bounds cross a
 * boundary) into a list column/filter, entirely independent of IFC pset
 * data — the assignment math itself is unit-tested in
 * `apps/viewer/src/lib/zones`; this only exercises the engine's resolution
 * of the `getZoneAssignment` provider hook.
 */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum } from '@ifc-lite/data';
import { executeList } from './engine.js';
import type { ListDataProvider, ListDefinition } from './types.js';

type Assignment = { zoneName: string | null; straddles: boolean; touchedZoneNames: string[] };

function createProvider(assignments: Map<number, Assignment>): ListDataProvider {
  return {
    getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1, 2, 3, 4] : []),
    getEntityName: (id) => `Wall-${id}`,
    getEntityGlobalId: (id) => `guid-${id}`,
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: () => 'IfcWall',
    getPropertySets: () => [],
    getQuantitySets: () => [],
    getZoneAssignment: (id, setId) => (setId === 'sections' ? assignments.get(id) ?? null : null),
    getZoneSetNames: () => [{ id: 'sections', name: 'Sections' }],
  };
}

function walls(columns: ListDefinition['columns'], conditions: ListDefinition['conditions'] = []): ListDefinition {
  return { id: 't', name: 'T', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], conditions, columns };
}

describe('zone column/condition (#1810)', () => {
  const assignments = new Map<number, Assignment>([
    [1, { zoneName: 'Section A', straddles: false, touchedZoneNames: [] }],
    [2, { zoneName: null, straddles: true, touchedZoneNames: ['Section A', 'Section B'] }],
    [3, { zoneName: null, straddles: false, touchedZoneNames: [] }], // unassigned
    // straddles=true but touchedZoneNames is empty (e.g. the viewer-side
    // zone math flagged a boundary crossing without resolving named
    // zones) — must fall back to zoneName, not join an empty list.
    [4, { zoneName: 'Section C (fallback)', straddles: true, touchedZoneNames: [] }],
  ]);

  it('resolves the zone name for a cleanly-assigned element', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }]),
      createProvider(assignments),
    );
    expect(result.rows.find(r => r.entityId === 1)!.values[0]).toBe('Section A');
  });

  it('joins the touched zone names when the element straddles a boundary', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }]),
      createProvider(assignments),
    );
    expect(result.rows.find(r => r.entityId === 2)!.values[0]).toBe('Section A, Section B');
  });

  it('resolves null for an unassigned element', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }]),
      createProvider(assignments),
    );
    expect(result.rows.find(r => r.entityId === 3)!.values[0]).toBe(null);
  });

  it('falls back to zoneName when straddles is true but touchedZoneNames is empty', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }]),
      createProvider(assignments),
    );
    expect(result.rows.find(r => r.entityId === 4)!.values[0]).toBe('Section C (fallback)');
  });

  it('resolves the Straddles boolean column independent of the Zone column', () => {
    const result = executeList(
      walls([{ id: 's', source: 'zone', psetName: 'sections', propertyName: 'Straddles' }]),
      createProvider(assignments),
    );
    expect(result.rows.map(r => r.values[0])).toEqual([false, true, false, true]);
  });

  it('an unknown zone-set id resolves to null (provider has no data for it)', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'takt', propertyName: 'Zone' }]),
      createProvider(assignments),
    );
    expect(result.rows.every(r => r.values[0] === null)).toBe(true);
  });

  it('filters rows via a zone equals condition', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }], [
        { source: 'zone', psetName: 'sections', propertyName: 'Zone', operator: 'equals', value: 'Section A' },
      ]),
      createProvider(assignments),
    );
    expect(result.rows.map(r => r.entityId)).toEqual([1]);
  });

  // Straddles resolves to a RAW JS boolean (unlike a pset property, it never
  // passes through resolvePropertyValue's display formatting), so it
  // stringifies lowercase ("true"/"false"). Case-insensitive `equals` must
  // still match a capitalized condition value like 'True' against it —
  // proves the boolean-case fix covers a genuine `typeof === 'boolean'`
  // CellValue, not just pset-derived "True"/"False" display strings.
  it('filters via a zone Straddles equals condition regardless of value case', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }], [
        { source: 'zone', psetName: 'sections', propertyName: 'Straddles', operator: 'equals', value: 'True' },
      ]),
      createProvider(assignments),
    );
    expect(result.rows.map(r => r.entityId).sort()).toEqual([2, 4]);
  });

  it('a provider with no getZoneAssignment resolves every zone column to null (backward compatible)', () => {
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
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }]),
      provider,
    );
    expect(result.rows[0].values[0]).toBe(null);
  });
});

/**
 * Volume apportionment columns (issue #2508). The clip itself is unit-tested in
 * `apps/viewer/src/lib/zones/apportionment.test.ts`; this exercises the
 * engine's resolution of the `getZoneVolumeShares` hook and — the part that is
 * easy to get wrong — that these columns are tagged as VOLUMES so the shared
 * per-column unit resolver converts and labels them.
 */
describe('zone volume columns (#2508)', () => {
  type Split = { homeValue: number | null; shares: Array<{ zoneName: string; value: number }> };

  function volumeProvider(splits: Map<number, Split>): ListDataProvider {
    return {
      ...createProvider(new Map()),
      getZoneVolumeShares: (id, setId) => (setId === 'sections' ? splits.get(id) ?? null : null),
    };
  }

  const splits = new Map<number, Split>([
    [1, { homeValue: 2.88, shares: [{ zoneName: 'Section A', value: 2.88 }, { zoneName: 'Section B', value: 4.32 }] }],
    // A straddler whose home zone could not be resolved (its centroid is in no
    // zone): the breakdown still exists, the single number does not.
    [2, { homeValue: null, shares: [{ zoneName: 'Section A', value: 1.5 }] }],
  ]);

  const volumeColumn = { id: 'v', source: 'zone' as const, psetName: 'sections', propertyName: 'Volume (mesh)' };
  const breakdownColumn = { id: 'b', source: 'zone' as const, psetName: 'sections', propertyName: 'Volume breakdown (mesh)' };

  it('reports the home zone share as a NUMBER, so it can be summed and compared', () => {
    const result = executeList(walls([volumeColumn]), volumeProvider(splits));
    expect(result.rows.find(r => r.entityId === 1)!.values[0]).toBe(2.88);
  });

  it('reports the full breakdown as text on the breakdown mode', () => {
    const result = executeList(walls([breakdownColumn]), volumeProvider(splits));
    expect(result.rows.find(r => r.entityId === 1)!.values[0]).toBe('Section A: 2.88, Section B: 4.32');
  });

  it('tags the numeric column as a VOLUME so the unit resolver can convert it', () => {
    // Without this the column carries raw cubic metres into a millimetre-volume
    // model's table and reads a billion times too small, silently.
    const result = executeList(walls([volumeColumn]), volumeProvider(splits));
    expect(result.columns[0]!.quantityType).toBe(2);
  });

  it('does NOT tag the breakdown column, which is text and must not be converted', () => {
    const result = executeList(walls([breakdownColumn]), volumeProvider(splits));
    expect(result.columns[0]!.quantityType).toBeUndefined();
  });

  it('is null until an apportionment exists, rather than clipping behind the user', () => {
    // The provider returns null when nothing has been computed for the set.
    const result = executeList(walls([volumeColumn]), volumeProvider(new Map()));
    expect(result.rows.every(r => r.values[0] === null)).toBe(true);
  });

  it('a straddler with no resolvable home zone yields null, not a wrong zone share', () => {
    const result = executeList(walls([volumeColumn, breakdownColumn]), volumeProvider(splits));
    const row = result.rows.find(r => r.entityId === 2)!;
    expect(row.values[0]).toBe(null);
    expect(row.values[1]).toBe('Section A: 1.5');
  });

  it('a provider built before #2508 simply has no volume data', () => {
    const legacy = createProvider(new Map());
    expect(legacy.getZoneVolumeShares).toBeUndefined();
    const result = executeList(walls([volumeColumn]), legacy);
    expect(result.rows.every(r => r.values[0] === null)).toBe(true);
  });

  it('the mode is matched case-insensitively, like every other zone mode', () => {
    const result = executeList(
      walls([{ id: 'v', source: 'zone', psetName: 'sections', propertyName: 'VOLUME (MESH)' }]),
      volumeProvider(splits),
    );
    expect(result.rows.find(r => r.entityId === 1)!.values[0]).toBe(2.88);
  });

  it('the plain Zone mode is untouched by the volume modes', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }]),
      volumeProvider(splits),
    );
    expect(result.columns[0]!.quantityType).toBeUndefined();
  });
});
