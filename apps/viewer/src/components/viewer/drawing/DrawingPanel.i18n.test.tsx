/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { PluralTranslation } from '@/i18n/types';
import type { section2dEn as Section2dEnType } from '@/i18n/catalogues/section-2d.en';
import { useViewerStore } from '@/store';
import { DrawingPanel } from './DrawingPanel.js';

let section2dEn: typeof Section2dEnType | undefined;
try {
  ({ section2dEn } = await import('@/i18n/catalogues/section-2d.en'));
} catch {
  section2dEn = undefined;
}

const CATALOGUE = section2dEn ?? ({} as typeof Section2dEnType);
const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, string | PluralTranslation> = {};
  for (const [key, value] of Object.entries(CATALOGUE)) {
    catalogue[key] = typeof value === 'string'
      ? marked(value)
      : Object.fromEntries(Object.entries(value).map(([form, text]) => [form, marked(text)])) as PluralTranslation;
  }
  return catalogue;
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState({
    drawing2DPanelVisible: true,
    drawing2DStatus: 'idle',
    drawing2D: null,
    drawing2DError: null,
    activeTool: 'select',
    activeModelId: null,
    ifcDataStore: null,
    models: new Map(),
  } as Partial<ReturnType<typeof useViewerStore.getState>>);
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('Drawing panel localization (#4918)', () => {
  it('updates mounted panel chrome and accessibility titles on a live locale change', () => {
    assert.ok(section2dEn, 'section-2d.en.ts catalogue must exist');
    const ui = render(<DrawingPanel />);
    assert.match(ui.textContent ?? '', /Drawing/);

    registerLocale('section-2d-pseudo', pseudoLocale());
    act(() => setLocale('section-2d-pseudo'));

    assert.match(ui.textContent ?? '', /⟦Drawing⟧/);
    const labels = [...ui.querySelectorAll('[aria-label]')].map((element) => element.getAttribute('aria-label'));
    assert.ok(labels.includes(marked(CATALOGUE['section2d.zoom.fit'])));
    assert.ok(labels.includes(marked(CATALOGUE['section2d.tools.distance'])));
  });
});
