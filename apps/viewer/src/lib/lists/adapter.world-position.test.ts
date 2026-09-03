/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `createListDataProvider`'s `zoneContext.getWorldPosition` (issue #3671)
 * threads through unchanged — the adapter itself has no geometry knowledge,
 * it just forwards the raw local expressId to whatever closure the caller
 * (ListPanel) built.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { createListDataProvider } from './adapter.js';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#2=IFCWALL('Wall000000000000000001A',$,'Wall-A',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

describe('createListDataProvider zoneContext.getWorldPosition (#3671)', () => {
  it('calls through to zoneContext.getWorldPosition with the raw expressId', async () => {
    const bytes = new TextEncoder().encode(FIXTURE);
    const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });

    const calls: number[] = [];
    const provider = createListDataProvider(store, '', {
      zoneSets: [],
      zoneAssignments: new Map(),
      toGlobalId: (id) => id,
      getWorldPosition: (expressId) => {
        calls.push(expressId);
        return { x: 1, y: 2, z: 3 };
      },
    });

    assert.deepEqual(provider.getWorldPosition?.(2), { x: 1, y: 2, z: 3 });
    assert.deepEqual(calls, [2]);
  });

  it('omitting zoneContext (or its getWorldPosition) resolves to null, not a throw', async () => {
    const bytes = new TextEncoder().encode(FIXTURE);
    const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });

    // No zoneContext at all — the pre-existing 1-arg call shape
    // (server-type-parity.test.ts's usage) still compiles/works unchanged.
    const provider = createListDataProvider(store);
    assert.equal(provider.getWorldPosition?.(2), null);

    // zoneContext present, but no getWorldPosition on it.
    const provider2 = createListDataProvider(store, 'model-name', {
      zoneSets: [],
      zoneAssignments: new Map(),
      toGlobalId: (id) => id,
    });
    assert.equal(provider2.getWorldPosition?.(2), null);
  });
});
