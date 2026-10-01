/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, cleanup, click, type as typeInto } from '@/test/render.js';
import type { FlowDocument } from '@ifc-lite/flow';
import { validateFlowDocument } from '@ifc-lite/flow';
import { newFlowDocument } from '@/lib/flow/persistence';
import { FlowFileSlotsEditor } from './FlowFileSlotsEditor';

afterEach(cleanup);
describe('file slot authoring (#6612)', () => {
  it('creates portable metadata and edits cardinality through controls', () => {
    let result: FlowDocument = { ...newFlowDocument('Load'), nodes: [{ id: 'load', type: 'session.loadModels' }],
      inputs: [{ nodeId: 'load', param: 'files', label: 'Models', kind: 'files', fileSlots: [] }] };
    function Harness() { const [doc, setDoc] = useState(result); return <FlowFileSlotsEditor doc={doc} nodeId="load" onChange={(next) => { result = next; setDoc(next); }} />; }
    const ui = render(<Harness />);
    const add = ui.querySelector('button'); assert.ok(add); click(add);
    const id = ui.querySelector('input[aria-label="File slot ID"]'); assert.ok(id); typeInto(id as HTMLInputElement, 'architecture');
    const extensions = ui.querySelector('input[aria-label="Accepted file extensions"]'); assert.ok(extensions); typeInto(extensions as HTMLInputElement, '.ifc');
    const multiple = ui.querySelector('input[type="checkbox"]'); assert.ok(multiple); click(multiple);
    assert.deepEqual(result.inputs[0].fileSlots, [{ id: 'architecture', label: 'Files 1', accept: '.ifc', multiple: true, required: true }]);
    assert.deepEqual(validateFlowDocument(result), []);
  });

});
