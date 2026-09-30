/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore, type RibbonTabId } from '@/store';
import { RIBBON_COLLAPSED_STORAGE_KEY } from '@/store/constants';
import { RibbonToolbar } from '@/components/viewer/ribbon/RibbonToolbar.js';
import { anchorSelector } from '../anchors.js';
import { captureUiSnapshot, restoreUiSnapshot } from '../snapshot.js';
import { patchTourState, resetTourState } from '../tour-store.js';
import { MEASURE_SECTION_TOUR } from './measure-section.js';

const initial = useViewerStore.getState();
const tabs: RibbonTabId[] = ['file', 'home', 'view', 'elements', 'analyze', 'author'];

afterEach(() => {
  cleanup();
  resetTourState();
  useViewerStore.setState(initial);
  window.localStorage.clear();
});

describe('Measure/Section tour ribbon anchors (#6576)', () => {
  for (const tab of tabs) {
    for (const collapsed of [false, true]) {
      for (const tool of ['measure', 'section'] as const) {
        it(`reaches ${tool} from ${tab}, ${collapsed ? 'collapsed' : 'expanded'}, and restores preferences`, async () => {
          // The real controller suspends contextual tab changes while running.
          patchTourState({ status: 'running', tourId: 'measure-section' });
          act(() => {
            useViewerStore.setState({
              ...fixtureModels(fixtureModel('tour-model')),
              loading: false, geometryStreamingActive: false,
              ribbonTab: tab, activeTool: 'select',
            });
            useViewerStore.getState().setRibbonCollapsed(collapsed);
          });
          const preference = window.localStorage.getItem(RIBBON_COLLAPSED_STORAGE_KEY);
          const snapshot = captureUiSnapshot(useViewerStore);
          const ui = render(<RibbonToolbar />);
          const step = MEASURE_SECTION_TOUR.steps.find((candidate) => candidate.id === `tool-${tool}`);
          assert.ok(step?.anchor, 'the real tour step targets a tool button');
          await act(async () => { await step.prepare?.(useViewerStore); });
          const button = ui.querySelector<HTMLButtonElement>(anchorSelector(step.anchor));
          assert.ok(button, 'preparation mounts the tool button before anchor resolution');
          assert.equal(button.disabled, false);
          click(button);
          assert.equal(useViewerStore.getState().activeTool, tool);
          assert.equal(step.gate?.predicate?.(useViewerStore.getState(), { baseline: {}, artifacts: new Map() }), true,
            'the real command satisfies the tour gate');
          assert.equal(window.localStorage.getItem(RIBBON_COLLAPSED_STORAGE_KEY), preference,
            'tour expansion never persists over the user preference');

          act(() => restoreUiSnapshot(useViewerStore, snapshot));
          assert.equal(useViewerStore.getState().ribbonTab, tab);
          assert.equal(useViewerStore.getState().ribbonCollapsed, collapsed);
          assert.equal(window.localStorage.getItem(RIBBON_COLLAPSED_STORAGE_KEY), preference);
          cleanup();
          resetTourState();
        });
      }
    }
  }
});
