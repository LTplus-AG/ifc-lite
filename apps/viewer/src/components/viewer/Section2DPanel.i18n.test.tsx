/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { section2dEn as Section2dEnType } from '@/i18n/catalogues/section-2d.en';
import { useViewerStore } from '@/store';
import { Section2DPanel } from './Section2DPanel.js';

let section2dEn: typeof Section2dEnType | undefined;
try {
  ({ section2dEn } = await import('@/i18n/catalogues/section-2d.en'));
} catch {
  section2dEn = undefined;
}

const CATALOGUE = section2dEn ?? ({} as typeof Section2dEnType);
const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, string> = {};
  for (const [key, value] of Object.entries(CATALOGUE)) catalogue[key] = marked(value);
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

describe('2D Section panel localization (#4918)', () => {
  it('updates mounted panel chrome and accessibility titles on a live locale change', () => {
    assert.ok(section2dEn, 'section-2d.en.ts catalogue must exist');
    const ui = render(<Section2DPanel />);
    assert.match(ui.textContent ?? '', /2D Section/);

    registerLocale('section-2d-pseudo', pseudoLocale());
    act(() => setLocale('section-2d-pseudo'));

    assert.match(ui.textContent ?? '', /⟦2D Section⟧/);
    const titles = [...ui.querySelectorAll('[title]')].map((element) => element.getAttribute('title'));
    assert.ok(titles.includes(marked(CATALOGUE['section2d.dragTitle'])));
    assert.ok(titles.includes(marked(CATALOGUE['section2d.close'])));
    assert.ok(titles.includes(marked(CATALOGUE['section2d.zoom.fit'])));
  });
});
