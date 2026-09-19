/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { AddElementPanel } from './AddElementPanel.js';
import type { addElementEn as AddElementEnType } from '@/i18n/catalogues/add-element.en';

let addElementEn: typeof AddElementEnType | undefined;
try {
  ({ addElementEn } = await import('@/i18n/catalogues/add-element.en'));
} catch (error) {
  console.error('[AddElementPanel.i18n] failed to load the feature catalogue', error);
  addElementEn = undefined;
}

const HAS_CATALOGUE = addElementEn !== undefined;
const CATALOGUE = addElementEn ?? ({} as typeof AddElementEnType);

function marked(text: string): string {
  return `⟦${text}⟧`;
}

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(CATALOGUE)) {
    if (typeof value === 'string') catalogue[key] = marked(value);
    else {
      catalogue[key] = { other: marked(value.other), one: marked(value.one) };
    }
  }
  return catalogue;
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState({
    activeModelId: null,
    models: new Map(),
    addElementType: 'wall',
    addElementModelId: null,
    addElementStoreyId: null,
    addElementPendingPoints: [],
  } as Partial<ReturnType<typeof useViewerStore.getState>>);
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('Add Element localization (#4918)', () => {
  it('updates visible panel chrome, type help, and accessibility text when the locale changes', () => {
    assert.ok(HAS_CATALOGUE, 'add-element.en.ts catalogue must exist');
    const ui = render(<AddElementPanel onClose={() => undefined} />);
    assert.match(ui.textContent ?? '', /Add Element/);
    assert.match(ui.textContent ?? '', /Click Start, then End/);
    assert.equal(ui.querySelector('[aria-label="Close add element panel"]')?.getAttribute('aria-label'), 'Close add element panel');

    registerLocale('add-element-pseudo', pseudoLocale());
    act(() => setLocale('add-element-pseudo'));

    assert.match(ui.textContent ?? '', /⟦Add Element⟧/);
    assert.match(ui.textContent ?? '', /⟦Click Start, then End/);
    assert.match(ui.textContent ?? '', /⟦Load a model to begin\.⟧/);
    assert.equal(
      ui.querySelector('button[aria-label]')?.getAttribute('aria-label'),
      marked(CATALOGUE['addElement.closeAria'] as string),
    );
  });

  it('uses the active locale throughout the Auto Spaces branch', () => {
    useViewerStore.setState({
      addElementType: 'space',
      addElementAutoSpacePreview: {
        storeyExpressId: 1,
        outlines: [],
        regions: [],
        wallsConsidered: 2,
        wallsContributing: 0,
        diagnostics: {
          vertices: 0,
          edgesAfterSplit: 0,
          facesTotal: 0,
          outerFacesDropped: 0,
          belowMinAreaDropped: 0,
          largestArea: 0,
          skipReasons: { 'no-placement': 1, 'placement-not-resolvable': 1 },
        },
      },
    });
    const ui = render(<AddElementPanel onClose={() => undefined} />);
    registerLocale('add-element-auto-pseudo', pseudoLocale());
    act(() => setLocale('add-element-auto-pseudo'));

    const text = ui.textContent ?? '';
    assert.match(text, /⟦Auto Spaces \(from walls\)⟧/);
    assert.match(text, /⟦Name pattern \(\{n\} = index\)⟧/);
    assert.match(text, /⟦Preview⟧/);
    assert.match(text, /⟦Generate⟧/);
    assert.match(text, /⟦Authoring is disabled until a model with a building storey is loaded\.⟧/);
    assert.match(text, /⟦placement missing⟧/);
    assert.match(text, /⟦placement could not be resolved⟧/);
    assert.doesNotMatch(text, /no-placement|placement-not-resolvable/);

    registerLocale('ar-EG', {});
    act(() => setLocale('ar-EG'));
    assert.match(ui.textContent ?? '', /٢/, 'Auto Spaces display counts must use active-locale digits');
  });

  it('recomputes unnamed-storey fallbacks and complete unit labels on a live locale change', () => {
    const model = fixtureModel('model.ifc', {
      entities: [{ expressId: 2, type: 'IfcBuildingStorey' }],
    });
    assert.ok(model.ifcDataStore);
    Object.assign(model.ifcDataStore, { getEntity: () => null });
    useViewerStore.setState(fixtureModels(model));
    const ui = render(<AddElementPanel onClose={() => undefined} />);
    assert.match(ui.textContent ?? '', /Storey #2/);
    assert.match(ui.textContent ?? '', /Thickness \(m\)/);

    registerLocale('add-element-storey-pseudo', pseudoLocale());
    act(() => setLocale('add-element-storey-pseudo'));
    assert.match(ui.textContent ?? '', /⟦Storey #2⟧/);
    assert.match(ui.textContent ?? '', /⟦Thickness \(m\)⟧/);

    act(() => registerLocale('add-element-storey-pseudo', {
      ...pseudoLocale(),
      'addElement.storeyFallback': 'Replaced storey #{id}',
    }));
    assert.match(ui.textContent ?? '', /Replaced storey #2/);

    registerLocale('ar-EG', {});
    act(() => setLocale('ar-EG'));
    assert.match(ui.textContent ?? '', /Storey #٢/);
  });
});
