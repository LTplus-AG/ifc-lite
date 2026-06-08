/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser, type IfcDataStore } from '../src/columnar-parser.js';
import { attachDataStoreAccessors } from '../src/data-store-accessors.js';

describe('attachDataStoreAccessors', () => {
  it('restores the lazy accessors a cache-restored store is missing', async () => {
    const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,'REI60',$);
#21=IFCPROPERTYSINGLEVALUE('IsExternal',$,.T.,$);
#30=IFCPROPERTYSET('pset-guid',#1,'Pset_WallCommon',$,(#20,#21));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);`;

    const source = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(source);
    const entityRefs = [];
    for (const ref of tokenizer.scanEntitiesFast()) {
      entityRefs.push({
        expressId: ref.expressId,
        type: ref.type,
        byteOffset: ref.offset,
        byteLength: ref.length,
        lineNumber: ref.line,
      });
    }

    const parser = new ColumnarParser();
    const store = (await parser.parseLite(source.buffer.slice(0), entityRefs, {})) as IfcDataStore;

    // Simulate a store rehydrated from the on-disk cache: the cache format only
    // serialises data, so the four lazy accessors arrive undefined — this is the
    // exact shape that crashed the Properties panel with
    // "store.getEntity is not a function".
    const stripped = store as unknown as Record<string, unknown>;
    delete stripped.getEntity;
    delete stripped.getEntitiesByType;
    delete stripped.getProperties;
    delete stripped.getQuantities;
    expect(typeof (store as { getEntity?: unknown }).getEntity).toBe('undefined');

    // The fix: reattach the accessors from the store's own source + index.
    attachDataStoreAccessors(store);

    expect(typeof store.getEntity).toBe('function');
    expect(typeof store.getEntitiesByType).toBe('function');
    expect(typeof store.getProperties).toBe('function');
    expect(typeof store.getQuantities).toBe('function');

    expect(store.getEntity(10)?.type).toBe('IFCWALLSTANDARDCASE');
    expect(store.getEntity(999)).toBeNull();
    expect(store.getEntitiesByType('IFCWALLSTANDARDCASE').map((e) => e.expressId)).toEqual([10]);

    const psets = store.getProperties(10);
    expect(psets).toHaveLength(1);
    expect(psets[0].name).toBe('Pset_WallCommon');
    expect(psets[0].properties.map((p) => p.name)).toEqual(['FireRating', 'IsExternal']);
  });
});
