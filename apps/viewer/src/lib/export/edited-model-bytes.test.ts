/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CSV exports read the model as edited (#5397). `editedModelBytes` is the
 * byte source both CSV entry points hand to the Rust exporter. Re-parse what
 * it returns: a deleted wall must be gone, a created one present, and a rename
 * applied. With no edits it must return the loaded bytes unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';

// Loaded at runtime: the changed-test oracle removes new production files, and
// a missing module must fail an assertion rather than the whole file's import.
const modulePath = './edited-model-bytes.js';
const mod: typeof import('./edited-model-bytes.js') | null = await import(modulePath).catch(() => null);

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Proj00000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall00000000000000010',$,'Wall A',$,$,$,$,$,$);
#11=IFCWALL('0Wall00000000000000011',$,'Wall B',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(bytes: Uint8Array): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}

describe('editedModelBytes (#5397)', () => {
  it('returns the loaded bytes when nothing was edited', async () => {
    assert.ok(mod, 'edited-model-bytes must exist');
    const store = await parse(new TextEncoder().encode(FIXTURE));
    const view = new MutablePropertyView(store.properties ?? null, 'm');
    configureMutationView(view, store);
    assert.deepEqual(mod!.editedModelBytes(store, view), store.source.materialize());
    assert.deepEqual(mod!.editedModelBytes(store, null), store.source.materialize());
  });

  it('re-serializes an edited model: deleted out, created in, rename applied', async () => {
    assert.ok(mod, 'edited-model-bytes must exist');
    const store = await parse(new TextEncoder().encode(FIXTURE));
    const view = new MutablePropertyView(store.properties ?? null, 'm');
    configureMutationView(view, store);
    view.setExpressIdWatermark(11);
    view.deleteEntity(11);
    view.setAttribute(10, 'Name', 'Wall A renamed', 'Wall A');
    const created = view.createEntity('IfcWall', ['2Wall00000000000000012', null, 'Wall C']).expressId;

    const edited = await parse(mod!.editedModelBytes(store, view));
    assert.equal(edited.entityIndex.byId.has(11), false, 'the deleted wall is not in the bytes');
    assert.equal(edited.entities.getName(10), 'Wall A renamed');
    assert.equal(edited.entities.getName(created), 'Wall C');
    assert.equal(edited.entities.getGlobalId(created), '2Wall00000000000000012');
  });
});

describe('editedModelBytes on an IFC2X3 model (#5397 review)', () => {
  it('re-serializes an edited IFC2X3 model too: only IFC5 has no STEP to regenerate', async () => {
    assert.ok(mod, 'edited-model-bytes must exist');
    const store = await parse(new TextEncoder().encode(FIXTURE.replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))")));
    assert.equal(store.schemaVersion, 'IFC2X3');
    const view = new MutablePropertyView(store.properties ?? null, 'm');
    configureMutationView(view, store);
    view.deleteEntity(11);

    const edited = await parse(mod!.editedModelBytes(store, view));
    assert.equal(edited.schemaVersion, 'IFC2X3');
    assert.equal(edited.entityIndex.byId.has(11), false, 'the IFC2X3 deletion reaches the bytes');
    assert.equal(edited.entityIndex.byId.has(10), true);
  });
});
