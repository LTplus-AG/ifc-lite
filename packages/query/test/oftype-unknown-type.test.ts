/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcQuery.ofType()` maps a type string through `IfcTypeEnumFromString`,
 * which falls back to `IfcTypeEnum.Unknown` for any name it does not
 * recognize. Left unchecked, a caller's typo (`'IfcWal'` for `'IfcWall'`) or
 * a vendor-specific type name silently queried the Unknown bucket instead —
 * every entity whose type this build's enum table could not classify, which
 * is neither the caller's wall nor an empty result, but some other,
 * unrelated set of entities. See `ifc-query.ts`.
 */

import { describe, it, expect } from 'vitest';
import { createMockStore } from './mock-store.js';
import { IfcQuery } from '../src/ifc-query.js';

describe('ofType() rejects an unrecognized type string', () => {
  it('throws rather than silently matching the Unknown bucket', () => {
    const store = createMockStore({
      entities: [
        { expressId: 10, type: 'IFCWALL', globalId: 'g10', name: 'Real Wall' },
        // Vendor / unrecognized entity type not in the enum map -> lands in
        // the Unknown bucket.
        { expressId: 20, type: 'IFCPROPRIETARYVENDORTHING', globalId: 'g20', name: 'Vendor Widget' },
      ],
    });
    const query = new IfcQuery(store as any);
    // Caller made a typo: 'IfcWal' instead of 'IfcWall'.
    expect(() => query.ofType('IfcWal')).toThrow(/unrecognized IFC type/);
  });

  it('still allows an explicit query for the Unknown bucket itself', async () => {
    const store = createMockStore({
      entities: [
        { expressId: 10, type: 'IFCWALL', globalId: 'g10', name: 'Real Wall' },
        { expressId: 20, type: 'IFCPROPRIETARYVENDORTHING', globalId: 'g20', name: 'Vendor Widget' },
      ],
    });
    const query = new IfcQuery(store as any);
    const ids = await query.ofType('Unknown').ids();
    expect(ids).toEqual([20]);
  });
});
