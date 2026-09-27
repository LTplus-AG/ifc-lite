/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { expandAffectedSet } from './affected-set';

// A wall (#100) voided by an opening (#110) filled by a window (#120); #130 is unrelated.
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#100=IFCWALL('0000000000000000000100',$,'W',$,$,$,$,$,$);
#110=IFCOPENINGELEMENT('0000000000000000000110',$,'O',$,$,$,$,$,.OPENING.);
#116=IFCRELVOIDSELEMENT('0000000000000000000116',$,$,$,#100,#110);
#120=IFCWINDOW('0000000000000000000120',$,'Win',$,$,$,$,$,$,$,$,$,$);
#122=IFCRELFILLSELEMENT('0000000000000000000122',$,$,$,#110,#120);
#130=IFCWALL('0000000000000000000130',$,'Other',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse() {
  const bytes = new TextEncoder().encode(FIXTURE);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

const sorted = (ids: Set<number>) => [...ids].sort((a, b) => a - b);

describe('expandAffectedSet (#6232)', () => {
  it('a moved host brings its openings and fillings; a reshaped one only itself', async () => {
    const store = await parse();
    assert.deepEqual(sorted(expandAffectedSet(store, null, [100], 'hostsChanged')), [100, 110, 120]);
    assert.deepEqual(sorted(expandAffectedSet(store, null, [100], 'shape')), [100]);
    assert.deepEqual(sorted(expandAffectedSet(store, null, [130], 'hostsChanged')), [130]);
  });

  it('a reshaped opening re-cuts its host', async () => {
    const store = await parse();
    assert.ok(expandAffectedSet(store, null, [110], 'shape').has(100));
  });

  it('follows relationships the session created and drops deleted ids', async () => {
    const store = await parse();
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);
    const opening = editor.addEntity('IfcOpeningElement', ['1open000000000000000000', null, 'O2', null, null, null, null, null, '.OPENING.']).expressId;
    editor.addEntity('IfcRelVoidsElement', ['1void000000000000000000', null, null, null, '#130', `#${opening}`]);
    assert.deepEqual(sorted(expandAffectedSet(store, view, [130], 'hostsChanged')), [130, opening]);
    editor.removeEntity(120);
    assert.deepEqual(sorted(expandAffectedSet(store, view, [100], 'hostsChanged')), [100, 110]);
    assert.equal(expandAffectedSet(store, view, [120], 'shape').size, 0);
  });
});
