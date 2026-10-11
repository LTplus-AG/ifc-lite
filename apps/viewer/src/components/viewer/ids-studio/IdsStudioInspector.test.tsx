/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-033 … IDS-037 through the mounted panel: schema pickers, the value
 * editor, a refused name and its candidate, a quick fix previewed then
 * applied, and the XML tab following the selection.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { IDSPropertyFacet } from '@ifc-lite/ids';
import { cleanup, click, press, render, type } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { loadStudioContexts } from '@/lib/ids-studio/context';
import { wallFixture, type WallFixture } from '@/test/ids-studio-fixture';
import { IdsStudioPanel } from './IdsStudioPanel';

const property = (): IDSPropertyFacet => {
  const facet = useViewerStore.getState().idsStudioState?.doc.ids.specifications[0].requirements[0].facet;
  assert.equal(facet?.type, 'property');
  return facet as IDSPropertyFacet;
};
const combobox = (root: HTMLElement, label: string) => {
  const forId = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)?.getAttribute('for');
  const el = forId ? root.querySelector<HTMLInputElement>(`[id="${forId}"]`) : null;
  assert.ok(el, `no control labelled ${label}`);
  return el;
};
const button = (root: HTMLElement, text: string) => {
  const el = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(el, `no button "${text}"`);
  return el;
};

let fixture: WallFixture;
beforeEach(async () => {
  useViewerStore.getState().idsStudioSetContexts(await loadStudioContexts());
  fixture = await wallFixture();
  useViewerStore.getState().idsStudioOpen(fixture.doc);
  useViewerStore.getState().idsStudioSelect(fixture.propertyId);
  useViewerStore.setState({ idsStudioView: 'inspector' });
});
afterEach(cleanup);

describe('IDS Studio inspector (IDS-033 … IDS-037)', () => {
  it('reads the requirement as a sentence and picks a property from the applicable set by keyboard', () => {
    const ui = render(<IdsStudioPanel />);
    assert.ok(ui.textContent?.includes('FireRating'), 'the facet sentence names the property');
    const picker = combobox(ui, 'Property');
    type(picker, 'IsExt');
    press(picker, 'ArrowDown');
    press(picker, 'Enter');
    assert.deepEqual(property().baseName, { type: 'simpleValue', value: 'IsExternal' });
    assert.deepEqual(property().dataType, { type: 'simpleValue', value: 'IFCBOOLEAN' }, 'the schema data type is filled in the same batch');
    assert.equal(useViewerStore.getState().idsStudioState?.history.past.length, 1, 'one undo step');
  });

  it('shows the gate refusal for a typed name and resubmits with a picked candidate', () => {
    const ui = render(<IdsStudioPanel />);
    const picker = combobox(ui, 'Property');
    type(picker, 'FireRatng');
    press(picker, 'Enter');
    assert.deepEqual(property().baseName, { type: 'simpleValue', value: 'FireRating' }, 'nothing written');
    const alert = ui.querySelector('[role="alert"]');
    assert.ok(alert?.textContent?.includes('GATE-PROP-001'));
    click(button(alert as HTMLElement, 'FireRating'));
    assert.equal(useViewerStore.getState().idsStudioRejection, null);
    assert.equal(useViewerStore.getState().idsStudioState?.history.past.length, 1);
  });

  it('edits the value as a list of chips and tests a sample against the stored value', () => {
    const ui = render(<IdsStudioPanel />);
    const kind = [...ui.querySelectorAll<HTMLSelectElement>('select')].find((s) => [...s.options].some((o) => o.value === 'oneOf'));
    assert.ok(kind);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(kind, 'oneOf');
      kind.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const chip = ui.querySelector<HTMLInputElement>('input[placeholder="Type a value and press Enter"]');
    assert.ok(chip);
    type(chip, 'EI60'); press(chip, 'Enter');
    type(chip, 'EI90'); press(chip, 'Enter');
    click(button(ui, 'Apply'));
    assert.deepEqual(property().value, { type: 'enumeration', values: ['EI60', 'EI90'] });
    // Once stored, a further chip commits on its own as value.addEnumValue.
    type(chip, 'EI120'); press(chip, 'Enter');
    assert.deepEqual(property().value, { type: 'enumeration', values: ['EI60', 'EI90', 'EI120'] });
    const kinds = useViewerStore.getState().idsStudioState?.history.past.map((e) => e.ops[0].kind);
    assert.deepEqual(kinds, ['facet.setField', 'value.addEnumValue']);
    const sample = ui.querySelector<HTMLInputElement>('input[placeholder="Type a sample value"]');
    assert.ok(sample);
    type(sample, 'ei60');
    assert.equal(ui.querySelector("output")?.textContent, 'does not match');
    type(sample, 'EI90');
    assert.equal(ui.querySelector("output")?.textContent, 'matches');
  });

  it('previews a quick fix, leaves the document alone until applied, then applies it as one step', () => {
    useViewerStore.getState().idsStudioDispatch([{ kind: 'facet.setField', opId: '0190a8a0-0000-7000-8000-0000000000aa', payload: { facetId: fixture.propertyId, field: 'property.value', value: { kind: 'equals', value: 'EI60 ' } } }]);
    const ui = render(<IdsStudioPanel />);
    const finding = [...ui.querySelectorAll('li')].find((li) => li.textContent?.includes('IDSL-VAL-006'));
    assert.ok(finding, 'the whitespace finding is listed');
    const before = useViewerStore.getState().idsStudioState?.doc;
    const fixButton = finding.querySelector<HTMLButtonElement>('button[aria-pressed]');
    assert.ok(fixButton);
    click(fixButton);
    const preview = ui.querySelector('section[aria-label="Quick-fix preview"]');
    assert.ok(preview?.textContent?.includes('This fix changes'));
    assert.equal(useViewerStore.getState().idsStudioState?.doc, before, 'preview only');
    click(button(preview as HTMLElement, 'Apply fix'));
    assert.deepEqual(property().value, { type: 'simpleValue', value: 'EI60' });
    assert.ok(![...ui.querySelectorAll('li')].some((li) => li.textContent?.includes('IDSL-VAL-006')), 'the finding is gone');
  });

  it('the XML tab shows the writer output and highlights the selected facet', () => {
    useViewerStore.setState({ idsStudioView: 'xml' });
    const ui = render(<IdsStudioPanel />);
    const editor = ui.querySelector('.cm-content');
    assert.ok(editor?.textContent?.includes('<specification name="Walls – fire rating"'));
    const marked = ui.querySelector('.cm-ids-selected');
    assert.ok(marked?.textContent?.includes('property'), 'the selected property element is highlighted');
  });
});
