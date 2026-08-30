/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `subset-roots.ts` (#2934, anonymized isolated export): drift-checks
 * `IFC_ROOT_TYPES` against the bundled schema tables directly — the same
 * "re-derive independently, then diff" strategy `reference-collector.test.ts`
 * uses for `PRODUCT_TYPES` — and checks `getSubsetEntityIds`'s "infrastructure
 * is always a root" invariant, since that is the one guarantee every other
 * subset-export consumer (`step-collection.ts`) relies on without
 * re-checking it itself.
 */

import { describe, it, expect } from 'vitest';
import { EMPTY_SOURCE_BYTES, type IfcDataStore } from '@ifc-lite/parser';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, type IfcEntityInfo } from '@ifc-lite/data';
import { IFC_ROOT_TYPES, IDENTIFYING_TYPES, getSubsetEntityIds } from './subset-roots.js';
import { getEffectiveEntityIndex } from './effective-index.js';

const SCHEMA_TABLES: ReadonlyArray<readonly IfcEntityInfo[]> = [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3];

/** Same shape `reference-collector.test.ts`'s local `mockStore` uses. */
function mockStore(entries: Array<[number, string]>): IfcDataStore {
  const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
  const byType = new Map<string, number[]>();
  for (const [id, type] of entries) {
    byId.set(id, { expressId: id, type, byteOffset: 0, byteLength: 0, lineNumber: 0 });
    const upper = type.toUpperCase();
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(id);
  }
  return { entityIndex: { byId, byType }, source: EMPTY_SOURCE_BYTES } as unknown as IfcDataStore;
}

describe('IFC_ROOT_TYPES (drift against the bundled schema tables)', () => {
  it('is not empty (anti-vacuity for the diff below)', () => {
    expect(IFC_ROOT_TYPES.size).toBeGreaterThan(0);
  });

  it('contains every concrete IfcRoot descendant declared by the bundled schemas, and nothing else', () => {
    // Re-derived independently of `collectDescendantNames` — walking the same
    // `parent` chain by hand — so this test cannot pass merely because it
    // shares a bug with the code under test.
    const declared = new Set<string>();
    for (const table of SCHEMA_TABLES) {
      const parentOf = new Map(table.map((e) => [e.name, e.parent]));
      for (const entity of table) {
        let cursor: string | null | undefined = parentOf.get(entity.name);
        for (let guard = 0; cursor && guard < 64; guard++) {
          if (cursor === 'IfcRoot') {
            declared.add(entity.name.toUpperCase());
            break;
          }
          cursor = parentOf.get(cursor);
        }
      }
    }

    const missing = [...declared].filter((name) => !IFC_ROOT_TYPES.has(name));
    expect(missing, 'IfcRoot descendants the schema declares but IFC_ROOT_TYPES omits').toEqual([]);

    const strays = [...IFC_ROOT_TYPES].filter((name) => !declared.has(name));
    expect(strays, 'classified as IfcRoot descendants but not declared as one in any bundled schema').toEqual([]);
  });

  it('includes well-known rooted types spanning object, relationship and definition branches', () => {
    // Anti-vacuity by name: a broken walk that returned an empty (or
    // near-empty) set would still pass the pure diff above vacuously.
    for (const name of ['IFCWALL', 'IFCPROJECT', 'IFCRELAGGREGATES', 'IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCPROPERTYSET', 'IFCWALLTYPE']) {
      expect(IFC_ROOT_TYPES.has(name), `${name} expected in IFC_ROOT_TYPES`).toBe(true);
    }
  });

  it('excludes non-rooted geometry/placement/material types (control)', () => {
    for (const name of ['IFCCARTESIANPOINT', 'IFCLOCALPLACEMENT', 'IFCAXIS2PLACEMENT3D', 'IFCMATERIAL', 'IFCSHAPEREPRESENTATION', 'IFCDIRECTION']) {
      expect(IFC_ROOT_TYPES.has(name), `${name} unexpectedly in IFC_ROOT_TYPES`).toBe(false);
    }
  });

  it('does not itself contain the abstract IfcRoot supertype', () => {
    expect(IFC_ROOT_TYPES.has('IFCROOT')).toBe(false);
  });
});

describe('getSubsetEntityIds: infrastructure is always a root, regardless of includedIds', () => {
  it('roots every INFRASTRUCTURE_TYPES entity present, even with an empty includedIds', () => {
    const store = mockStore([
      [1, 'IFCOWNERHISTORY'],
      [2, 'IFCAPPLICATION'],
      [3, 'IFCPERSON'],
      [4, 'IFCORGANIZATION'],
      [5, 'IFCSIUNIT'],
      [6, 'IFCUNITASSIGNMENT'],
      [7, 'IFCGEOMETRICREPRESENTATIONCONTEXT'],
      // A rooted, non-infrastructure entity nobody included.
      [8, 'IFCWALL'],
    ]);
    const index = getEffectiveEntityIndex(store, null, false);

    const { roots, excludedIds } = getSubsetEntityIds(index, new Set());

    for (const id of [1, 2, 3, 4, 5, 6, 7]) {
      expect(roots.has(id), `infrastructure id #${id} expected in roots`).toBe(true);
      expect(excludedIds.has(id), `infrastructure id #${id} unexpectedly excluded`).toBe(false);
    }
    // The uninclued IfcRoot descendant is excluded, not silently rooted.
    expect(excludedIds.has(8)).toBe(true);
    expect(roots.has(8)).toBe(false);
  });

  it('an included IfcRoot id becomes a root and is never in excludedIds', () => {
    const store = mockStore([
      [1, 'IFCOWNERHISTORY'],
      [2, 'IFCWALL'],
      [3, 'IFCWALL'],
    ]);
    const index = getEffectiveEntityIndex(store, null, false);

    const { roots, excludedIds } = getSubsetEntityIds(index, new Set([2]));

    expect(roots.has(2)).toBe(true);
    expect(excludedIds.has(2)).toBe(false);
    // The sibling wall, not included, is excluded.
    expect(excludedIds.has(3)).toBe(true);
    expect(roots.has(3)).toBe(false);
  });

  it('excludes an un-included IDENTIFYING_TYPES entity the same way as an IfcRoot one', () => {
    const store = mockStore([
      [1, 'IFCOWNERHISTORY'],
      [2, 'IFCPOSTALADDRESS'],
      [3, 'IFCMAPCONVERSION'],
    ]);
    const index = getEffectiveEntityIndex(store, null, false);

    const { roots, excludedIds } = getSubsetEntityIds(index, new Set());

    expect(excludedIds.has(2)).toBe(true);
    expect(excludedIds.has(3)).toBe(true);
    expect(roots.has(2)).toBe(false);
    expect(roots.has(3)).toBe(false);
  });

  it('leaves a non-root, non-identifying, non-included entity out of both sets (deferred to the closure walk)', () => {
    const store = mockStore([
      [1, 'IFCOWNERHISTORY'],
      [2, 'IFCCARTESIANPOINT'],
    ]);
    const index = getEffectiveEntityIndex(store, null, false);

    const { roots, excludedIds } = getSubsetEntityIds(index, new Set());

    expect(roots.has(2)).toBe(false);
    expect(excludedIds.has(2)).toBe(false);
  });

  it('IDENTIFYING_TYPES is disjoint from IFC_ROOT_TYPES (each entity classified exactly one way)', () => {
    const overlap = [...IDENTIFYING_TYPES].filter((name) => IFC_ROOT_TYPES.has(name));
    expect(overlap).toEqual([]);
  });
});
