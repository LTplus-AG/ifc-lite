/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from './index';
import { ViewportWelcomeCard } from '@/components/viewer/ViewportWelcomeCard';

const initial = useViewerStore.getState();
const tourStorage = window.localStorage.getItem('ifc-lite:tours:v1');
afterEach(() => {
  cleanup();
  resetFeaturesForTest();
  useViewerStore.setState(initial, true);
  if (tourStorage === null) window.localStorage.removeItem('ifc-lite:tours:v1');
  else window.localStorage.setItem('ifc-lite:tours:v1', tourStorage);
});
it('uses the opening heading when samples or blank models are offered (#10176)', () => {
  for (const feature of ['files.samples', 'edit.model'] as const) {
    resetFeaturesForTest({ default: 'none', enable: [feature] });
    const card = render(<ViewportWelcomeCard webgpu={{ supported: true, checking: false }} onOpenClick={() => {}}
      onStartBlank={() => {}} recentFiles={[]} loadFile={async () => {}} />);
    assert.ok(card.querySelector('button'));
    assert.equal(card.querySelector('h2')?.textContent, 'Open a model');
    cleanup();
  }
});