/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import type { PlayerField } from '@/lib/flow/player-fields';
import { validatePlayerValue, initialPlayerValues } from '@/lib/flow/player-fields';
import { savePlayerValues, loadPlayerValues } from '@/lib/flow/player-values';
import type { SelectedFiles } from '@/lib/flow/file-values';
import { FlowFilesField } from './FlowFilesField';

afterEach(cleanup);
const field: PlayerField = { key: 'load.files', input: { nodeId: 'load', param: 'files', label: 'Models', kind: 'files',
  fileSlots: [{ id: 'models', label: 'IFC models', accept: '.ifc', multiple: true, required: true }] }, paramKind: 'json', options: [], default: {} };

describe('workflow file slots (#6612)', () => {
  it('selects real File handles, validates slots and clears without serializing source bytes', () => {
    let selected: SelectedFiles = {};
    function Harness() { const [value, setValue] = useState<SelectedFiles>({}); return <FlowFilesField field={field} value={value} onChange={(next) => { selected = next; setValue(next); }} />; }
    const ui = render(<Harness />);
    const input = ui.querySelector('input'); assert.ok(input);
    assert.equal(input.accept, '.ifc'); assert.equal(input.multiple, true);
    const file = new File(['IFC bytes'], 'architecture.ifc');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(selected.models[0], file);
    assert.equal(validatePlayerValue(field, selected).ok, true);
    assert.match(ui.textContent ?? '', /architecture.ifc/);
    const clear = ui.querySelector('button'); assert.ok(clear); click(clear);
    assert.equal(validatePlayerValue(field, selected).ok, false);
    assert.notEqual(ui.querySelector('input'), input, 'clearing remounts the native file input');
  });
  it('never restores file handles or runtime tokens from stored Player values', () => {
    localStorage.clear();
    const file = new File(['bytes'], 'a.ifc');
    savePlayerValues('graph', { 'load.files': { models: [file] }, token: 'flow-resource:run:abc', count: '5' });
    assert.deepEqual(loadPlayerValues('graph'), { count: '5' });
    assert.equal(initialPlayerValues([field], { 'load.files': { models: ['forged'] } })['load.files'], undefined);
    assert.equal(validatePlayerValue(field, { models: ['forged'] }).ok, false);
    assert.equal(validatePlayerValue(field, { unknown: [file] }).ok, false);
    assert.equal(validatePlayerValue(field, { models: [new File([''], 'wrong.pdf')] }).ok, false);
  });
});
