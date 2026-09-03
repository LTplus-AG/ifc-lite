/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The write guard's "is it in the source model" question, asked the way every
 * other site in the repo asks it.
 *
 * On a big file the parser keeps property atoms out of `entityIndex.byId` and
 * puts them in `deferredEntityIndex` (`deferPropertyAtomIndex`). They are
 * ordinary entities: they hold express ids, the exporter emits them, and
 * `StoreEditor`'s id watermark already spans both indexes. A guard that asked
 * `byId` alone therefore refused a write to an entity that is in the file and
 * IS exported, which is the opposite of the mistake it exists to catch (#3764).
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { HeadlessBackend } from './headless-backend.js';
import { ifcFile } from './headless-test-helpers.js';

const MODEL = ifcFile(`#70= IFCWALL('WALL00000000000000000X',$,'Wall',$,$,$,$,'tag',$);
#100= IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('W-01'),$);
#102= IFCPROPERTYSET('PSET00000000000000000X',$,'Pset_WallCommon',$,(#100));
#103= IFCRELDEFINESBYPROPERTIES('RELP00000000000000000X',$,$,$,(#70),#102);`);

/** Parse with the huge-file option that splits the entity index in two. */
async function deferredStore() {
  const bytes = new TextEncoder().encode(MODEL);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, {
    deferPropertyAtomIndex: true,
  });
  return store;
}

describe('the write guard over a store with a deferred property-atom index', () => {
  it('accepts a write to an entity that is only in deferredEntityIndex', async () => {
    const store = await deferredStore();
    // The fixture only means anything if the split actually happened: #100 has
    // to be OUT of the primary index and IN the deferred one.
    expect(store.entityIndex.byId.has(100)).toBe(false);
    expect(store.deferredEntityIndex?.has(100)).toBe(true);

    const backend = new HeadlessBackend(store, 'model.ifc');
    expect(() => backend.mutate.setAttribute({ modelId: 'default', expressId: 100 }, 'Name', 'Renamed'))
      .not.toThrow();
  });

  it('still refuses an id neither index holds', async () => {
    // Guards the case above: the union must widen the answer for the deferred
    // ids, not for every id.
    const store = await deferredStore();
    const backend = new HeadlessBackend(store, 'model.ifc');

    expect(() => backend.mutate.setAttribute({ modelId: 'default', expressId: 999999 }, 'Name', 'Ghost'))
      .toThrow(/no entity #999999/);
  });
});
