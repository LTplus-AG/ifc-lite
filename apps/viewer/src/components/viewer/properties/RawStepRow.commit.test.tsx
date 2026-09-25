/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5872, second site: the Raw STEP row's inline editor committed on every
 * blur like the attribute editor did. Opening an argument and clicking away
 * recorded an undo entry and cleared the redo branch for an unchanged token.
 *
 * Mounted over the real viewer store with a real parsed model and a real
 * MutablePropertyView (setPositionalAttribute writes through its StoreEditor).
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
import { RawStepRow } from './RawStepRow.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('raw.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0Wall00000000000000001',$,'Wall A',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

let parsed: Promise<IfcDataStore> | null = null;
function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(IFC);
  parsed ??= new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return parsed;
}

const REDO_SENTINEL = { id: 'redo-sentinel', type: 'UPDATE_ATTRIBUTE', timestamp: 0, modelId: 'm', entityId: 1 } as Mutation;
const TOKEN = "'Wall A'";

async function seed(): Promise<void> {
  const store = await parse();
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: store }),
    mutationViews: new Map([['m', new MutablePropertyView(store.properties ?? null, 'm')]]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map([['m', [REDO_SENTINEL]]]),
    dirtyModels: new Set(),
    collabRole: null,
  });
}

function openEditor(): HTMLInputElement {
  const container = render(
    <RawStepRow modelId="m" entityId={1} index={2} name="Name" displayToken={TOKEN} isMutated={false} enableEditing />,
  );
  const value = [...container.querySelectorAll('button')].find((b) => b.textContent === TOKEN);
  assert.ok(value, 'the argument value renders');
  click(value!);
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
const key = (input: HTMLInputElement, name: string) =>
  act(() => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true })); });
const blur = (input: HTMLInputElement) =>
  act(() => { input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });

const undo = () => useViewerStore.getState().undoStacks.get('m') ?? [];
const redo = () => useViewerStore.getState().redoStacks.get('m') ?? [];

describe('Raw STEP row commits only real changes (#5872)', () => {
  beforeEach(seed);
  afterEach(() => cleanup());

  it('opening and blurring without typing records nothing and keeps redo', () => {
    blur(openEditor());
    assert.equal(undo().length, 0, 'no undo entry for an unchanged token');
    assert.deepEqual(redo(), [REDO_SENTINEL], 'the redo branch survives');
  });

  it('Escape after typing commits nothing, even through the following blur', () => {
    const input = openEditor();
    type(input, "'Changed'");
    key(input, 'Escape');
    blur(input);
    assert.equal(undo().length, 0);
  });

  it('a changed token commits exactly one undo entry', () => {
    const input = openEditor();
    type(input, "'Wall B'");
    key(input, 'Enter');
    blur(input);
    assert.equal(undo().length, 1);
  });
});
