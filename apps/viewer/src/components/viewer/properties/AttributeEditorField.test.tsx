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
import { MutablePropertyView, StoreEditor, type Mutation } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';

// Guarded: the module is new in #5872. With the fix reverted it is absent, and
// the tests must fail on an assertion (the revert oracle), not on a load error.
const editorModule: Partial<typeof import('./AttributeEditorField.js')> =
  await import('./AttributeEditorField.js').catch(() => ({}));
function editor() {
  const { AttributeEditorField, judgeAttributeEdit } = editorModule;
  assert.ok(AttributeEditorField && judgeAttributeEdit, 'properties/AttributeEditorField exports the editor (#5872)');
  return { AttributeEditorField, judgeAttributeEdit };
}

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
  const { AttributeEditorField } = editor();
  return render(<AttributeEditorField modelId="m" entityId={1} attrName={attrName} currentValue={currentValue} />);
}

function openEditor(container: HTMLElement, currentValue: string): HTMLInputElement {
  const display = [...container.querySelectorAll('button')].find((b) => b.textContent === currentValue);
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
    const alert = container.querySelector('[role="alert"]');
    assert.match(alert?.textContent ?? '', /22 characters/);
    assert.ok(alert?.id && input.getAttribute('aria-describedby') === alert.id, 'the field references its message');
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

  it('uniqueness counts this session\'s GlobalId edits, both ways', () => {
    const fresh = '3FreshGuid000000000000';
    // Wall B was just given `fresh`: it is taken now, although no parsed row has it.
    useViewerStore.getState().setAttribute('m', 2, 'GlobalId', fresh, GUID_B);
    let container = mount('GlobalId', GUID_A);
    let input = openEditor(container, GUID_A);
    type(input, fresh);
    key(input, 'Enter');
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /already has this GlobalId/);
    assert.equal(undo().length, 1, 'only the seeding edit is recorded');
    cleanup();
    // …and Wall B's old GUID is free again, although the parsed index still names it.
    container = mount('GlobalId', GUID_A);
    input = openEditor(container, GUID_A);
    type(input, GUID_B);
    key(input, 'Enter');
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(undo().length, 2, 'the freed GUID commits');
  });

  it('editing a value this session blanked records the blank as the undo value', () => {
    useViewerStore.getState().setAttribute('m', 1, 'Description', '', undefined);
    const input = openEditor(mount('Description', ''), 'empty');
    type(input, 'Filled');
    key(input, 'Enter');
    assert.equal(undo().length, 2);
    assert.equal(undo()[1].oldValue, '', 'the previous value is the blank, not "no value"');
    useViewerStore.getState().undo('m');
    const view = useViewerStore.getState().mutationViews.get('m')!;
    assert.deepEqual(view.getAttributeMutationsForEntity(1), [{ name: 'Description', value: '' }], 'undo returns to the blank edit');
  });

  it('the legacy model\'s positional GlobalId edits count toward uniqueness', async () => {
    const { modelGlobalIdOwner } = await import('./global-id-check.js');
    const store = await parse();
    const view = new MutablePropertyView(null, '__legacy__');
    useViewerStore.setState({ models: new Map(), ifcDataStore: store, mutationViews: new Map([['__legacy__', view]]), storeEditors: new Map([['__legacy__', new StoreEditor(store, view)]]), undoStacks: new Map() });
    const fresh = '3FreshGuid000000000000';
    useViewerStore.getState().setPositionalAttribute('__legacy__', 2, 0, fresh);
    assert.equal(modelGlobalIdOwner('legacy')(fresh), 2, 'Wall B carries the GUID it was just given');
  });

  it('judgeAttributeEdit: a valid, unused GlobalId commits trimmed', () => {
    const { judgeAttributeEdit } = editor();
    const owner = (guid: string) => (guid === GUID_B ? 2 : -1);
    assert.deepEqual(judgeAttributeEdit('GlobalId', ` ${'3'.repeat(22)} `, GUID_A, 1, owner), { kind: 'commit', value: '3'.repeat(22) });
    assert.deepEqual(judgeAttributeEdit('GlobalId', GUID_A, GUID_A, 1, owner), { kind: 'unchanged' });
    // Free text keeps its whitespace: only an identical value is a no-op.
    assert.deepEqual(judgeAttributeEdit('Name', 'Wall A ', 'Wall A', 1, owner), { kind: 'commit', value: 'Wall A ' });
  });
});
