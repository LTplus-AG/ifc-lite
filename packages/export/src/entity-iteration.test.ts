/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `entity-iteration.ts` had no test file. Its iteration half is well pinned
 * indirectly — dropping `yield* deferred` fails four exporter tests — but its
 * `size` is not: reporting only the primary index's size left the whole suite
 * green, and `size` is what `StepExporter`/`MergedExporter` report as the
 * export's entity total (`step-exporter.ts:1069`, `merged-exporter.ts:611`).
 *
 * A user with a `deferPropertyAtomIndex` parse sees an export summary that
 * undercounts by every deferred property atom — thousands on a real file —
 * while the file itself is complete.
 */

import { describe, it, expect } from 'vitest';
import type { IfcDataStore } from '@ifc-lite/parser';
import { getCompleteEntityIndex, getMaxExpressId, type ExportEntityRef } from './entity-iteration.js';

const ref = (type: string, byteOffset: number): ExportEntityRef => ({ type, byteOffset, byteLength: 10 });

/**
 * `byId` and `deferredEntityIndex` are DISJOINT by construction and here have
 * DIFFERENT sizes (2 vs 3) — equal sizes would let `byId.size + deferred.size`
 * and `deferred.size * 2` agree, and either alone would be half the total.
 */
function storeWithDeferred(): IfcDataStore {
  return {
    entityIndex: {
      byId: new Map([
        [1, ref('IFCWALL', 0)],
        [2, ref('IFCPROPERTYSET', 20)],
      ]),
    },
    deferredEntityIndex: new Map([
      [7, ref('IFCPROPERTYSINGLEVALUE', 40)],
      [8, ref('IFCPROPERTYSINGLEVALUE', 60)],
      [9, ref('IFCQUANTITYAREA', 80)],
    ]),
  } as unknown as IfcDataStore;
}

function storeWithoutDeferred(): IfcDataStore {
  return {
    entityIndex: {
      byId: new Map([
        [1, ref('IFCWALL', 0)],
        [2, ref('IFCPROPERTYSET', 20)],
      ]),
    },
  } as unknown as IfcDataStore;
}

describe('getCompleteEntityIndex', () => {
  it('counts the deferred atoms in size, not just the primary index', () => {
    expect(getCompleteEntityIndex(storeWithDeferred()).size).toBe(5);
  });

  it('resolves and reports membership across both indexes', () => {
    const index = getCompleteEntityIndex(storeWithDeferred());
    expect(index.get(1)?.type).toBe('IFCWALL');
    expect(index.get(9)?.type).toBe('IFCQUANTITYAREA');
    expect(index.get(999)).toBeUndefined();
    expect(index.has(2)).toBe(true);
    expect(index.has(8)).toBe(true);
    expect(index.has(999)).toBe(false);
  });

  it('iterates every id from both indexes exactly once', () => {
    const ids = [...getCompleteEntityIndex(storeWithDeferred())].map(([id]) => id);
    expect(ids).toEqual([1, 2, 7, 8, 9]);
  });

  it('size stays consistent with what iteration yields', () => {
    const index = getCompleteEntityIndex(storeWithDeferred());
    expect([...index]).toHaveLength(index.size);
  });

  it('returns the primary index itself when nothing was deferred', () => {
    const store = storeWithoutDeferred();
    expect(getCompleteEntityIndex(store)).toBe(store.entityIndex.byId as never);
  });

  it('takes the fast path for an EMPTY deferred index too', () => {
    // The third state alongside "absent" and "populated": present but empty.
    const store = storeWithoutDeferred() as unknown as { deferredEntityIndex: Map<number, ExportEntityRef> };
    store.deferredEntityIndex = new Map();
    const index = getCompleteEntityIndex(store as unknown as IfcDataStore);
    expect(index.size).toBe(2);
    expect(index).toBe((store as unknown as IfcDataStore).entityIndex.byId as never);
  });
});

describe('getMaxExpressId', () => {
  it('returns the largest id present, including one that only the deferred index holds', () => {
    expect(getMaxExpressId(getCompleteEntityIndex(storeWithDeferred()))).toBe(9);
  });

  it('returns the id itself, not its predecessor (the next free id is caller-side)', () => {
    const index = getCompleteEntityIndex({
      entityIndex: { byId: new Map([[42, ref('IFCWALL', 0)]]) },
    } as unknown as IfcDataStore);
    expect(getMaxExpressId(index)).toBe(42);
  });

  it('returns 0 for an empty index', () => {
    const index = getCompleteEntityIndex({
      entityIndex: { byId: new Map() },
    } as unknown as IfcDataStore);
    expect(getMaxExpressId(index)).toBe(0);
  });

  it('is order-independent — a descending index reports the same maximum', () => {
    // A monotonically increasing fixture lets "return the LAST id" pass too.
    const index = getCompleteEntityIndex({
      entityIndex: {
        byId: new Map([
          [50, ref('IFCWALL', 0)],
          [10, ref('IFCSLAB', 20)],
          [30, ref('IFCBEAM', 40)],
        ]),
      },
    } as unknown as IfcDataStore);
    expect(getMaxExpressId(index)).toBe(50);
  });
});
