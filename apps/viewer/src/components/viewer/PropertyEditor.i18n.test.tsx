/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { activate, cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { propertyEditorEn as PropertyEditorEnType } from '@/i18n/catalogues/property-editor.en';
import {
  AddClassificationDialog,
  AddMaterialDialog,
  AddQuantityDialog,
  NewPropertyDialog,
  PropertyEditor,
  ReassignClassDialog,
} from './PropertyEditor.js';

let propertyEditorEn: typeof PropertyEditorEnType | undefined;
try {
  ({ propertyEditorEn } = await import('@/i18n/catalogues/property-editor.en'));
} catch {
  propertyEditorEn = undefined;
}

const CATALOGUE = propertyEditorEn ?? ({} as typeof PropertyEditorEnType);
const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(CATALOGUE)) {
    catalogue[key] = typeof value === 'string'
      ? marked(value)
      : { one: marked(value.one), other: marked(value.other) };
  }
  return catalogue;
}

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('Property editor localization (#4918)', () => {
  it('#5823 opens inline editing from the value with Enter and Space', () => {
    for (const key of ['Enter', ' '] as const) {
      const ui = render(
        <PropertyEditor modelId="model" entityId={1} psetName="Pset_Test" propName="Name" currentValue="Original" />,
      );
      const value = ui.querySelector<HTMLButtonElement>('button[title="Click to edit"]');
      assert.ok(value, 'the inline value must be a keyboard-focusable control');
      activate(value, key);
      assert.ok(ui.querySelector('input'), `${key} did not open the editor`);
      cleanup();
    }
  });

  it('updates inline editing chrome when the active locale changes', () => {
    assert.ok(propertyEditorEn, 'property-editor.en.ts catalogue must exist');
    const ui = render(
      <PropertyEditor modelId="model" entityId={1} psetName="Pset_Test" propName="Name" currentValue="Original" />,
    );
    registerLocale('property-editor-inline-pseudo', pseudoLocale());
    act(() => setLocale('property-editor-inline-pseudo'));

    const value = ui.querySelector('[title]');
    assert.equal(value?.getAttribute('title'), marked(CATALOGUE['propertyEditor.inline.clickToEdit'] as string));
    click(value!);
    assert.equal(
      ui.querySelector('input')?.getAttribute('placeholder'),
      marked(CATALOGUE['propertyEditor.inline.enterValue'] as string),
    );
  });

  it('updates read-only boolean and logical values when the active locale changes', () => {
    assert.ok(propertyEditorEn, 'property-editor.en.ts catalogue must exist');
    const ui = render(
      <div>
        <PropertyEditor modelId="model" entityId={1} psetName="Pset_Test" propName="Enabled" currentValue />
        <PropertyEditor modelId="model" entityId={1} psetName="Pset_Test" propName="Disabled" currentValue={false} />
        <PropertyEditor modelId="model" entityId={1} psetName="Pset_Test" propName="Logical" currentValue=".U." />
      </div>,
    );
    registerLocale('property-editor-readonly-pseudo', pseudoLocale());
    act(() => setLocale('property-editor-readonly-pseudo'));

    const text = ui.textContent ?? '';
    assert.match(text, /⟦True⟧/);
    assert.match(text, /⟦False⟧/);
    assert.match(text, /⟦Unknown⟧/);
  });

  it('updates every enrichment-dialog trigger without remounting', () => {
    const ui = render(
      <div>
        <NewPropertyDialog modelId="model" entityId={1} entityType="IfcWall" existingPsets={[]} />
        <AddQuantityDialog modelId="model" entityId={1} entityType="IfcWall" existingQtos={[]} />
        <AddClassificationDialog modelId="model" entityId={1} entityType="IfcWall" />
        <AddMaterialDialog modelId="model" entityId={1} entityType="IfcWall" />
        <ReassignClassDialog modelId="model" entityId={1} entityType="IfcWall" />
      </div>,
    );
    registerLocale('property-editor-triggers-pseudo', pseudoLocale());
    act(() => setLocale('property-editor-triggers-pseudo'));

    // Icon-only triggers are named by IconButton's aria-label; the labelled
    // Reassign trigger keeps its title.
    const titles = [...ui.querySelectorAll('button')].flatMap((button) => [button.getAttribute('aria-label'), button.getAttribute('title')]);
    for (const key of [
      'propertyEditor.property.trigger',
      'propertyEditor.quantity.trigger',
      'propertyEditor.classification.trigger',
      'propertyEditor.material.trigger',
      'propertyEditor.reassign.trigger',
    ] as const) {
      assert.ok(titles.includes(marked(CATALOGUE[key] as string)), `${key} must use the active locale`);
    }
  });

  it('renders complete translated messages inside the property dialog', () => {
    const ui = render(
      <NewPropertyDialog modelId="model" entityId={1} entityType="IfcWall" existingPsets={[]} schemaVersion="IFC4" />,
    );
    registerLocale('property-editor-dialog-pseudo', pseudoLocale());
    act(() => setLocale('property-editor-dialog-pseudo'));
    click(ui.querySelector('button')!);

    const text = document.body.textContent ?? '';
    assert.match(text, /⟦Add Property⟧/);
    assert.match(text, /⟦Add a property to this IfcWall element\.⟧/);
    assert.match(text, /⟦Property Set⟧/);

    const propertySetSelect = document.body.querySelector('[role="combobox"]');
    assert.ok(propertySetSelect);
    click(propertySetSelect);
    assert.match(
      document.body.textContent ?? '',
      /⟦IFC standard property set: Pset_WallCommon⟧/,
      'imported English suggestion prose must not leak into a contributed locale',
    );

    registerLocale('fr', { 'propertyEditor.property.title': 'Ajouter une propriété' });
    act(() => setLocale('fr'));
    assert.match(
      document.body.textContent ?? '',
      /Properties common to the definition of all occurrences of IfcWall/,
      'a partial locale must retain detailed schema guidance when it omits the display-description key',
    );
  });
});
