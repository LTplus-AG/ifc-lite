/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * swisstopo's terms make the source reference mandatory wherever the data is
 * shown: the viewport line is there exactly while a site-context model is
 * visible, names every dataset once, and adds the imagery's own line once it
 * is draped.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { SiteContextAttribution } from './SiteContextAttribution';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

const attribution = (datasetId: string, text: string) => ({ datasetId, text, licence: 'OGD', termsUrl: 'https://example.invalid', restrictions: [], termsVerifiedOn: '2026-11-15' });
const line = () => document.querySelector('[data-testid="site-context-attribution"]');

test('the attribution line shows while a site-context model is visible and goes when none is', () => {
  const terrain = fixtureModel('terrain');
  const parcel = fixtureModel('parcel');
  useViewerStore.setState({ ...fixtureModels(fixtureModel('building'), terrain, parcel) });
  render(<SiteContextAttribution />);
  assert.equal(line(), null, 'no context model: no line');

  act(() => {
    const state = useViewerStore.getState();
    state.registerSiteContextModel('terrain', { kind: 'terrain', attribution: [attribution('swissalti3d', '© swisstopo')], issues: [], complete: true, origin: [2_680_700, 1_251_420, 524] });
    state.registerSiteContextModel('parcel', {
      kind: 'parcel', complete: false, origin: [2_680_700, 1_251_420, 524], issues: [],
      attribution: [attribution('cadastralwebmap', '© Cadastral surveying (CS) and the cantons'), attribution('oereb', '© swisstopo')],
    });
  });
  assert.equal(line()?.textContent, '© swisstopo · © Cadastral surveying (CS) and the cantons');

  act(() => useViewerStore.getState().updateSiteContextModel('terrain', {
    imagery: { attribution: attribution('swissimage', '© CNES, Spot Image, swisstopo, NPOC'), groundSampleDistance: 0.25 },
  }));
  assert.match(line()?.textContent ?? '', /CNES, Spot Image, swisstopo, NPOC/);

  // Hiding one context model keeps the line for the other; hiding both removes it.
  act(() => useViewerStore.setState({ models: new Map([...useViewerStore.getState().models].map(([id, m]) => [id, id === 'terrain' ? { ...m, visible: false } : m])) }));
  assert.equal(line()?.textContent, '© Cadastral surveying (CS) and the cantons · © swisstopo');
  act(() => useViewerStore.setState({ models: new Map([...useViewerStore.getState().models].map(([id, m]) => [id, id === 'parcel' ? { ...m, visible: false } : m])) }));
  assert.equal(line(), null);
});

test('a removed site-context model takes its attribution with it', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('terrain')) });
  render(<SiteContextAttribution />);
  act(() => useViewerStore.getState().registerSiteContextModel('terrain', { kind: 'terrain', attribution: [attribution('swissalti3d', '© swisstopo')], issues: [], complete: true, origin: [0, 0, 0] }));
  assert.ok(line());
  act(() => useViewerStore.setState({ models: new Map() }));
  assert.equal(line(), null);
});

test('every source stays readable: the line wraps instead of cutting text off behind an ellipsis (#10481 review)', () => {
  const terrain = fixtureModel('terrain');
  useViewerStore.setState({ ...fixtureModels(terrain) });
  render(<SiteContextAttribution />);
  act(() => {
    useViewerStore.getState().registerSiteContextModel('terrain', {
      kind: 'terrain', complete: true, origin: [0, 0, 0], issues: [],
      attribution: [attribution('swissalti3d', '© swisstopo'), attribution('cadastralwebmap', '© Cadastral surveying (CS) and the cantons')],
    });
  });
  const el = line() as HTMLElement;
  assert.match(el.textContent ?? '', /© Cadastral surveying \(CS\) and the cantons/);
  // happy-dom does not lay out: check the rendered element is not set to clip its text.
  assert.equal(el.classList.contains('truncate'), false);
  assert.ok(el.classList.contains('whitespace-normal'));
});
