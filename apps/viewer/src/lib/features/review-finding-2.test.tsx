/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from './index';
import { ModelHeaderRow } from '@/components/viewer/hierarchy/ModelHeaderRow';
import { openRepositionModels } from '@/lib/model-placement/commands';

const initial = useViewerStore.getState();
const tourStorage = window.localStorage.getItem('ifc-lite:tours:v1');
afterEach(() => {
  cleanup();
  resetFeaturesForTest();
  useViewerStore.setState(initial, true);
  if (tourStorage === null) window.localStorage.removeItem('ifc-lite:tours:v1');
  else window.localStorage.setItem('ifc-lite:tours:v1', tourStorage);
});
it('hides the per-model reposition button when placement is off (#10176)', () => {
  const row = () => render(<ModelHeaderRow node={{ id: 'A', name: 'A.ifc', type: 'model-header', depth: 0,
    expressIds: [], globalIds: [], modelIds: ['A'], hasChildren: false, isExpanded: false, isVisible: true }}
    virtualRow={{ size: 28, start: 0 }} modelsCount={1} onModelVisibilityToggle={() => {}}
    onRemoveModel={() => {}} onModelHeaderClick={() => {}} />);
  assert.ok(row().querySelector('button[aria-label*="Reposition"]'));
  cleanup();
  resetFeaturesForTest({ default: 'all', disable: ['edit.placement'] });
  assert.ok(!row().querySelector('button[aria-label*="Reposition"]'));
});
it('makes direct and wrapped reposition actions no-ops when placement is off (#10176)', () => {
  resetFeaturesForTest({ default: 'all', disable: ['edit.placement'] });
  const before = useViewerStore.getState();
  assert.doesNotThrow(() => before.openReposition(['missing']));
  openRepositionModels(['missing']);
  assert.equal(useViewerStore.getState(), before);
});