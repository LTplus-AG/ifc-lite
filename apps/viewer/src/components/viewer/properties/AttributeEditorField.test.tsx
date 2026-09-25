/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5872: the Properties panel's attribute editor committed on every blur.
 * Opening a field and clicking away recorded an undo entry, cleared the redo
 * branch and marked the model dirty for an unchanged value; Escape could still
 * commit through the blur that follows it; and GlobalId accepted any string.
 *
 * Mounted over the real viewer store with a real parsed model and a real
 * MutablePropertyView, driving the input the way a user does.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { AttributeEditorField, judgeAttributeEdit } from './AttributeEditorField.js';

const GUID_A = '0Wall00000000000000001';
const GUID_B = '0Wall00000000000000002';
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('attr.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('${GUID_A}',$,'Wall A',$,$,$,$,$,$);
#2=IFCWALL('${GUID_B}',$,'Wall B',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

let parsed: Promise<IfcDataStore> | null = null;
function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  parsed ??= new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return parsed;
}

/** An unrelated earlier redo entry, which a no-op commit must not clear. */
const REDO_SENTINEL = { id: 'redo-sentinel', type: 'UPDATE_ATTRIBUTE', timestamp: 0, modelId: 'm', entityId: 2 } as Mutation;

async function seed(): Promise<void> {
  const store = await parse();
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: store }),
    mutationViews: new Map([['m', new MutablePropertyView(null, 'm')]]),
    undoStacks: new Map(),
    redoStacks: new Map([['m', [REDO_SENTINEL]]]),
    dirtyModels: new Set(),
    collabRole: null,
  });
}

function mount(attrName: string, currentValue: string): HTMLElement {
  return render(<AttributeEditorField modelId="m" entityId={1} attrName={attrName} currentValue={currentValue} />);
}

function openEditor(container: HTMLElement, currentValue: string): HTMLInputElement {
  const display = [...container.querySelectorAll('span')].find((s) => s.textContent === currentValue);
  assert.ok(display, 'the attribute value renders');
  click(display!);
  const input = container.querySelector('input');
  assert.ok(input, 'clicking the value opens the editor');
  return input!;
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function key(input: HTMLInputElement, name: string): void {
  act(() => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true })); });
}

function blur(input: HTMLInputElement): void {
  act(() => { input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
}

const undo = () => useViewerStore.getState().undoStacks.get('m') ?? [];
const redo = () => useViewerStore.getState().redoStacks.get('m') ?? [];

describe('attribute editor commits only real, valid changes (#5872)', () => {
  beforeEach(seed);
  afterEach(() => cleanup());

  it('opening and blurring without typing records nothing and keeps redo', () => {
    const input = openEditor(mount('Name', 'Wall A'), 'Wall A');
    blur(input);
    assert.equal(undo().length, 0, 'no undo entry for an unchanged value');
    assert.deepEqual(redo(), [REDO_SENTINEL], 'the redo branch survives');
    assert.equal(useViewerStore.getState().dirtyModels.has('m'), false, 'the model is not marked dirty');
  });

  it('Enter commits exactly one undo entry, even though the input then blurs', () => {
    const input = openEditor(mount('Name', 'Wall A'), 'Wall A');
    type(input, 'Wall A2');
    key(input, 'Enter');
    blur(input);
    assert.equal(undo().length, 1);
    assert.equal(undo()[0].newValue, 'Wall A2');
  });

  it('Escape after typing commits nothing', () => {
    const input = openEditor(mount('Name', 'Wall A'), 'Wall A');
    type(input, 'discard me');
    key(input, 'Escape');
    blur(input);
    assert.equal(undo().length, 0);
    assert.deepEqual(redo(), [REDO_SENTINEL]);
  });

  it('an invalid GlobalId is rejected with a message and nothing is recorded', () => {
    const container = mount('GlobalId', GUID_A);
    const input = openEditor(container, GUID_A);
    type(input, 'not-a-guid');
    key(input, 'Enter');
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /22 characters/);
    assert.equal(undo().length, 0);
  });

  it('a GlobalId already used by another element in the model is rejected', () => {
    const container = mount('GlobalId', GUID_A);
    const input = openEditor(container, GUID_A);
    type(input, GUID_B);
    key(input, 'Enter');
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /already has this GlobalId/);
    assert.equal(undo().length, 0);
  });

  it('judgeAttributeEdit: a valid, unused GlobalId commits trimmed', () => {
    const owner = (guid: string) => (guid === GUID_B ? 2 : -1);
    assert.deepEqual(judgeAttributeEdit('GlobalId', ` ${'3'.repeat(22)} `, GUID_A, 1, owner), { kind: 'commit', value: '3'.repeat(22) });
    assert.deepEqual(judgeAttributeEdit('GlobalId', GUID_A, GUID_A, 1, owner), { kind: 'unchanged' });
    // Free text keeps its whitespace: only an identical value is a no-op.
    assert.deepEqual(judgeAttributeEdit('Name', 'Wall A ', 'Wall A', 1, owner), { kind: 'commit', value: 'Wall A ' });
  });
});
